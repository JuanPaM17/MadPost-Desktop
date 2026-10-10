import { Badge, Box, Button, Flex, Heading, Input, Stack, Table, Text } from "@chakra-ui/react";
import { Check, Filter, KeyRound, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LocalUser, UserRole } from "../../core/types";
import { sessionContext } from "../../core/session/SessionContext";
import { notify } from "../../components/ui/AppToaster";
import { ScrollableSelect } from "../../components/ui/ScrollableSelect";
import { authService } from "./AuthService";
import { PaginationControls } from "../../components/ui/PaginationControls";
import { rolesService, type Role } from "../roles/RolesService";

type Editor = { user: LocalUser | null; username: string; name: string; password: string; role: string };

export function UsersView({ onCurrentUserUpdated }: { onCurrentUserUpdated: (user: LocalUser) => void }) {
  const session = sessionContext.current(); const isSuperAdmin = session?.user.role === "SUPERADMIN"; const canManage = sessionContext.hasPermission("users.manage"); const [users, setUsers] = useState<LocalUser[]>([]); const [roles, setRoles] = useState<Role[]>([]); const [query, setQuery] = useState(""); const [roleFilter, setRoleFilter] = useState("ALL"); const [statusFilter, setStatusFilter] = useState("ALL"); const [filtersOpen, setFiltersOpen] = useState(false); const [editor, setEditor] = useState<Editor | null>(null); const [recoveryCode, setRecoveryCode] = useState<string | null>(null); const [confirm, setConfirm] = useState<{ user: LocalUser; mode: "delete" | "deactivate" } | null>(null); const [pageSize, setPageSize] = useState(10); const [page, setPage] = useState(1); const tenantId = session?.tenantId ?? "";
  const refresh = useCallback(async () => { try { const [userList, roleList] = await Promise.all([authService.listUsers(tenantId), rolesService.listRoles(tenantId)]); setUsers(userList); setRoles(roleList); } catch { notify.error("No fue posible cargar los usuarios."); } }, [tenantId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const filtered = useMemo(() => users.filter((user) =>
    (isSuperAdmin || user.role !== "SUPERADMIN") &&
    `${user.username} ${user.display_name ?? ""} ${roleLabel(user.role)}`.toLowerCase().includes(query.toLowerCase().trim()) &&
    (roleFilter === "ALL" || user.role === roleFilter) &&
    (statusFilter === "ALL" || String(user.active) === statusFilter)
  ), [users, query, isSuperAdmin, roleFilter, statusFilter]);
  const size = pageSize || Math.max(filtered.length, 1); const pages = Math.max(1, Math.ceil(filtered.length / size)); const visible = pageSize ? filtered.slice((Math.min(page, pages) - 1) * size, Math.min(page, pages) * size) : filtered;
  async function saveEditor() { if (!editor || !session) return; try { if (editor.user) { const updated = await authService.updateUser(editor.user, editor.username, editor.name, editor.user.id === session.user.id ? editor.user.role : editor.role); setUsers((current) => current.map((user) => user.id === updated.id ? updated : user)); if (updated.id === session.user.id) { sessionContext.login(updated, session.tenantName); onCurrentUserUpdated(updated); } notify.success(`Usuario guardado: ${updated.username}`); } else { const created = await authService.createUser(tenantId, editor.username, editor.password, editor.name, editor.role); await authService.generateRecoveryCode(created.id).then(setRecoveryCode); setUsers((current) => [...current, created]); notify.success(`Usuario creado: ${created.username}`); } setEditor(null); } catch (error) { notify.error("No fue posible guardar el usuario.", error instanceof Error ? error.message : undefined); } }
  async function generateCode(user: LocalUser) { try { setRecoveryCode(await authService.generateRecoveryCode(user.id)); } catch { notify.error("No fue posible generar el codigo."); } }
  async function requestDelete(user: LocalUser) { if (user.id === session?.user.id) { notify.error("No puedes eliminar tu propio usuario."); return; } const check = await authService.deletionCheck(user); if (!check.canDelete) { notify.error(`No puedes eliminar a ${user.username}. ${check.reason}.`); return; } setConfirm({ user, mode: "delete" }); }
  async function confirmAction() { if (!confirm) return; try { if (confirm.mode === "delete") { await authService.deleteUser(confirm.user); setUsers((current) => current.filter((user) => user.id !== confirm.user.id)); notify.success(`Usuario eliminado: ${confirm.user.username}`); } else { const updated = await authService.setUserActive(confirm.user, false); setUsers((current) => current.map((user) => user.id === updated.id ? updated : user)); notify.success(`Usuario desactivado: ${updated.username}`); } setConfirm(null); } catch { notify.error("No fue posible completar la accion."); } }
  async function toggle(user: LocalUser) { if (user.id === session?.user.id) return; if (user.active) { setConfirm({ user, mode: "deactivate" }); return; } try { const updated = await authService.setUserActive(user, true); setUsers((current) => current.map((item) => item.id === updated.id ? updated : item)); notify.success(`Usuario activado: ${updated.username}`); } catch { notify.error("No fue posible activar el usuario."); } }
  const confirmTitle = confirm?.mode === "delete" ? "Eliminar usuario" : "Desactivar usuario";
  const confirmMessage = confirm?.mode === "delete" ? `Eliminar a '${confirm.user.username}'? Esta accion no se puede deshacer.` : `Desactivar a '${confirm?.user.username ?? ""}'? No podra iniciar sesion.`;
  return <Box maxW="1180px" mx="auto">
    <Flex gap="3" mb="5" wrap="wrap">
      <Box flex="1" minW={{ base: "full", md: "260px" }} position="relative">
        <Search size={17} color="#6b7280" style={{ position: "absolute", left: 12, top: 11, zIndex: 1 }} />
        <Input pl="10" placeholder="Buscar usuario, nombre o rol..." value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
      </Box>
      <Button variant="outline" onClick={() => setFiltersOpen(true)}><Filter size={18} />Filtros</Button>
      {canManage ? <Button colorPalette="purple" onClick={() => setEditor({ user: null, username: "", name: "", password: "", role: "SELLER" })}><Plus size={17} />Nuevo usuario</Button> : null}
    </Flex>
    {(roleFilter !== "ALL" || statusFilter !== "ALL") ? <Flex mb="4" px="3" py="2" bg="purple.50" borderWidth="1px" borderColor="purple.100" borderRadius="md" align="center" justify="space-between" gap="3" wrap="wrap"><Text color="purple.800" fontSize="sm">Filtros activos: {[roleFilter !== "ALL" ? `Rol: ${roleLabel(roleFilter)}` : null, statusFilter !== "ALL" ? `Estado: ${statusFilter === "1" ? "Activos" : "Inactivos"}` : null].filter(Boolean).join(" · ")}</Text><Button size="sm" variant="ghost" colorPalette="purple" onClick={() => { setRoleFilter("ALL"); setStatusFilter("ALL"); setPage(1); }}>Limpiar filtros</Button></Flex> : null}
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
      <Box overflowX="auto">
        <Table.Root size="sm" minW="700px">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Usuario</Table.ColumnHeader>
              <Table.ColumnHeader>Nombre</Table.ColumnHeader>
              <Table.ColumnHeader>Rol</Table.ColumnHeader>
              <Table.ColumnHeader>Estado</Table.ColumnHeader>
              {canManage ? <Table.ColumnHeader textAlign="right">Acciones</Table.ColumnHeader> : null}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {visible.map((user) => <Table.Row key={user.id} opacity={user.active ? 1 : 0.45}>
              <Table.Cell fontFamily="mono">{user.username}</Table.Cell>
              <Table.Cell>{user.display_name || "-"}</Table.Cell>
              <Table.Cell>{roleLabel(user.role)}</Table.Cell>
              <Table.Cell><Badge colorPalette={user.active ? "green" : "gray"}>{user.active ? "Activo" : "Inactivo"}</Badge></Table.Cell>
              {canManage ? <Table.Cell textAlign="right"><Flex justify="end" gap="2" wrap="wrap">
                <Button size="xs" variant="outline" onClick={() => setEditor({ user, username: user.username, name: user.display_name ?? "", password: "", role: user.role })}><Pencil size={14} />Editar</Button>
                <Button size="xs" variant="outline" onClick={() => void generateCode(user)}><KeyRound size={14} />Codigo acceso</Button>
                <Button size="xs" variant="outline" colorPalette={user.active ? "red" : "gray"} disabled={user.id === session?.user.id} onClick={() => void toggle(user)}>{user.active ? "Desactivar" : "Activar"}</Button>
                <Button size="xs" variant="outline" colorPalette="red" onClick={() => void requestDelete(user)}><Trash2 size={14} />Eliminar</Button>
              </Flex></Table.Cell> : null}
            </Table.Row>)}
            {!visible.length ? <Table.Row><Table.Cell colSpan={canManage ? 5 : 4}><Text py="10" textAlign="center" color="gray.500">No hay usuarios para mostrar.</Text></Table.Cell></Table.Row> : null}
          </Table.Body>
        </Table.Root>
      </Box>
      <PaginationControls total={filtered.length} page={Math.min(page, pages)} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(nextSize) => { setPageSize(nextSize); setPage(1); }} />
    </Box>
    {filtersOpen ? <UserFiltersDialog roles={roles} isSuperAdmin={isSuperAdmin} roleFilter={roleFilter} statusFilter={statusFilter} onClose={() => setFiltersOpen(false)} onApply={(rf, sf) => { setRoleFilter(rf); setStatusFilter(sf); setPage(1); setFiltersOpen(false); }} /> : null}
    {editor ? <UserEditor editor={editor} isSelf={editor.user?.id === session?.user.id} isSuperAdmin={isSuperAdmin} roles={roles} onChange={setEditor} onClose={() => setEditor(null)} onSave={() => void saveEditor()} /> : null}
    {confirm ? <ConfirmDialog title={confirmTitle} message={confirmMessage} onClose={() => setConfirm(null)} onConfirm={() => void confirmAction()} /> : null}
    {recoveryCode ? <CodeDialog code={recoveryCode} onClose={() => setRecoveryCode(null)} /> : null}
  </Box>;
}

function UserEditor({ editor, isSelf, isSuperAdmin, roles, onChange, onClose, onSave }: { editor: Editor; isSelf: boolean; isSuperAdmin: boolean; roles: Role[]; onChange: (value: Editor | null) => void; onClose: () => void; onSave: () => void }) {
  const update = (values: Partial<Editor>) => onChange({ ...editor, ...values });
  const roleOptions = [...roles.filter((r) => isSuperAdmin || r.name !== "SUPERADMIN").map((r) => ({ value: r.name, label: roleLabel(r.name) })), ...(isSuperAdmin ? [{ value: "SUPERADMIN", label: "Super Admin" }] : [])];
  return <Modal><Flex justify="space-between" align="center" mb="5"><Heading size="md">{editor.user ? "Editar usuario" : "Nuevo usuario"}</Heading><Button size="sm" variant="ghost" onClick={onClose}><X size={17} /></Button></Flex><Stack gap="4"><Field label="Usuario *"><Input autoFocus value={editor.username} onChange={(event) => update({ username: event.target.value })} /></Field><Field label="Nombre"><Input value={editor.name} onChange={(event) => update({ name: event.target.value })} /></Field>{!editor.user ? <Field label="Contrasena *"><Input type="password" value={editor.password} placeholder="Minimo 4 caracteres" onChange={(event) => update({ password: event.target.value })} /></Field> : null}<Field label="Rol"><ScrollableSelect placement="bottom" value={editor.role} placeholder="Selecciona un rol" disabled={isSelf} options={roleOptions} onValueChange={(value) => update({ role: value })} /></Field><Flex justify="end" gap="3"><Button variant="outline" onClick={onClose}>Cancelar</Button><Button colorPalette="purple" onClick={onSave}><Check size={17} />Guardar</Button></Flex></Stack></Modal>;
}
function CodeDialog({ code, onClose }: { code: string; onClose: () => void }) { return <Modal><Flex justify="space-between" align="center" mb="5"><Heading size="md">Codigo de acceso</Heading><Button size="sm" variant="ghost" onClick={onClose}><X size={17} /></Button></Flex><Text color="gray.600">Comparte este codigo una sola vez con el usuario.</Text><Box mt="5" p="4" bg="purple.50" borderWidth="1px" borderColor="purple.200" fontFamily="mono" fontWeight="bold" textAlign="center">{code}</Box><Flex mt="5" justify="end"><Button colorPalette="purple" onClick={onClose}>Listo</Button></Flex></Modal>; }
function ConfirmDialog({ title, message, onClose, onConfirm }: { title: string; message: string; onClose: () => void; onConfirm: () => void }) { return <Modal><Flex justify="space-between" align="center" mb="5"><Heading size="md">{title}</Heading><Button size="sm" variant="ghost" onClick={onClose}><X size={17} /></Button></Flex><Text color="gray.600">{message}</Text><Flex mt="6" justify="end" gap="3"><Button variant="outline" onClick={onClose}>Cancelar</Button><Button colorPalette="red" onClick={onConfirm}>Confirmar</Button></Flex></Modal>; }
function UserFiltersDialog({ roles, isSuperAdmin, roleFilter, statusFilter, onClose, onApply }: { roles: Role[]; isSuperAdmin: boolean; roleFilter: string; statusFilter: string; onClose: () => void; onApply: (role: string, status: string) => void }) {
  const [draftRole, setDraftRole] = useState(roleFilter);
  const [draftStatus, setDraftStatus] = useState(statusFilter);
  const roleOptions = [
    { value: "ALL", label: "Todos los roles" },
    ...roles.filter((r) => isSuperAdmin || r.name !== "SUPERADMIN").map((r) => ({ value: r.name, label: roleLabel(r.name) })),
    ...(isSuperAdmin ? [{ value: "SUPERADMIN", label: "Super Admin" }] : []),
  ];
  return <Modal maxW="460px">
    <Flex justify="space-between" align="center" mb="5">
      <Heading size="md">Filtros de usuarios</Heading>
      <Button size="sm" variant="ghost" onClick={onClose}><X size={17} /></Button>
    </Flex>
    <Stack gap="5">
      <Field label="Rol">
        <ScrollableSelect placement="bottom" value={draftRole} placeholder="Todos los roles" options={roleOptions} onValueChange={setDraftRole} />
      </Field>
      <Field label="Estado">
        <ScrollableSelect placement="bottom" value={draftStatus} placeholder="Todos los estados" options={[{ value: "ALL", label: "Todos los estados" }, { value: "1", label: "Activos" }, { value: "0", label: "Inactivos" }]} onValueChange={setDraftStatus} />
      </Field>
    </Stack>
    <Flex justify="space-between" gap="3" mt="7">
      <Button variant="ghost" onClick={() => { setDraftRole("ALL"); setDraftStatus("ALL"); }}>Limpiar filtros</Button>
      <Flex gap="3">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button colorPalette="purple" onClick={() => onApply(draftRole, draftStatus)}><Check size={17} />Aplicar</Button>
      </Flex>
    </Flex>
  </Modal>;
}
function Modal({ children, maxW = "460px" }: { children: React.ReactNode; maxW?: string }) { return <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5"><Box w="full" maxW={maxW} bg="white" borderRadius="md" p="6" boxShadow="2xl">{children}</Box></Flex>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <Box><Text mb="2" fontWeight="semibold" fontSize="sm">{label}</Text>{children}</Box>; }
function roleLabel(role: string) { return role === "ADMIN" ? "Administrador" : role === "SELLER" ? "Vendedor" : role === "SUPERADMIN" ? "Super Admin" : role; }
