import { Badge, Box, Button, Checkbox, Flex, Heading, Input, Stack, Text } from "@chakra-ui/react";
import { Check, Pencil, Plus, Shield, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { sessionContext } from "../../core/session/SessionContext";
import { notify } from "../../components/ui/AppToaster";
import { MODULE_LABELS, MODULE_ORDER, PERMISSION_DEFS, type PermissionCode } from "./permissions";
import { rolesService, type Role } from "./RolesService";

export function RolesView() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [selected, setSelected] = useState<Role | null>(null);
  const [permissions, setPermissions] = useState<PermissionCode[]>([]);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<{ role: Role | null; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [blockedUsers, setBlockedUsers] = useState<{ username: string; display_name: string | null }[] | null>(null);
  const tenantId = sessionContext.current()?.tenantId ?? "";
  const isSuperAdmin = sessionContext.current()?.user.role === "SUPERADMIN";

  const loadRoles = useCallback(async () => {
    try {
      const list = await rolesService.listRoles(tenantId, isSuperAdmin);
      setRoles(list);
      // Si habia uno seleccionado, actualizar la referencia
      setSelected((prev) => (prev ? (list.find((r) => r.id === prev.id) ?? list[0] ?? null) : list[0] ?? null));
    } catch {
      notify.error("No fue posible cargar los roles.");
    }
  }, [tenantId, isSuperAdmin]);

  useEffect(() => { void loadRoles(); }, [loadRoles]);

  useEffect(() => {
    if (!selected) { setPermissions([]); return; }
    rolesService.getPermissions(selected.id).then(setPermissions).catch(() => notify.error("No fue posible cargar los permisos."));
  }, [selected]);

  async function savePermissions() {
    if (!selected) return;
    setSaving(true);
    try {
      await rolesService.setPermissions(selected, permissions);
      notify.success(`Permisos guardados: ${selected.name}`);
    } catch (error) {
      notify.error("No fue posible guardar los permisos.", error instanceof Error ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  async function saveRole() {
    if (!editor) return;
    try {
      if (editor.role) {
        const updated = await rolesService.renameRole(editor.role, editor.name);
        notify.success(`Rol guardado: ${updated.name}`);
      } else {
        const created = await rolesService.createRole(tenantId, editor.name);
        notify.success(`Rol creado: ${created.name}`);
      }
      setEditor(null);
      await loadRoles();
    } catch (error) {
      notify.error("No fue posible guardar el rol.", error instanceof Error ? error.message : undefined);
    }
  }

  async function requestDelete(role: Role) {
    try {
      const users = await rolesService.getUsersWithRole(tenantId, role.name);
      if (users.length > 0) { setBlockedUsers(users); setDeleting(role); return; }
      setBlockedUsers(null);
      setDeleting(role);
    } catch {
      notify.error("No fue posible verificar el rol.");
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await rolesService.deleteRole(deleting);
      notify.success(`Rol eliminado: ${deleting.name}`);
      if (selected?.id === deleting.id) setSelected(null);
      setDeleting(null);
      await loadRoles();
    } catch (error) {
      notify.error("No fue posible eliminar el rol.", error instanceof Error ? error.message : undefined);
    }
  }

  function togglePermission(code: PermissionCode) {
    setPermissions((prev) =>
      prev.includes(code) ? prev.filter((p) => p !== code) : [...prev, code],
    );
  }

  return (
    <Box maxW="1200px" mx="auto">
      <Text mb="6" color="gray.600">
        Administra los roles de tu negocio y los permisos que tiene cada uno. Los roles ADMIN y SELLER son del sistema y no pueden eliminarse.
      </Text>
      <Flex gap="6" align="start" direction={{ base: "column", lg: "row" }}>
        {/* Panel izquierdo: lista de roles */}
        <Box w={{ base: "full", lg: "280px" }} flexShrink="0">
          <Flex justify="space-between" align="center" mb="3">
            <Text fontWeight="bold" fontSize="sm" color="gray.500">ROLES</Text>
            <Button size="xs" colorPalette="purple" variant="outline" onClick={() => setEditor({ role: null, name: "" })}>
              <Plus size={14} />Nuevo rol
            </Button>
          </Flex>
          <Stack gap="1">
            {roles.map((role) => (
              <Flex
                key={role.id}
                align="center"
                gap="2"
                px="3"
                py="2"
                borderRadius="md"
                cursor="pointer"
                bg={selected?.id === role.id ? "purple.50" : "white"}
                borderWidth="1px"
                borderColor={selected?.id === role.id ? "purple.200" : "gray.200"}
                _hover={{ bg: selected?.id === role.id ? "purple.50" : "gray.50" }}
                onClick={() => setSelected(role)}
              >
                <Shield size={15} color={selected?.id === role.id ? "#7c3aed" : "#9ca3af"} />
                <Text flex="1" fontSize="sm" fontWeight={selected?.id === role.id ? "semibold" : "normal"} color={selected?.id === role.id ? "purple.700" : "gray.800"}>
                  {role.name}
                </Text>
                {role.is_system ? (
                  <Badge size="sm" colorPalette="gray">Sistema</Badge>
                ) : (
                  <Flex gap="1">
                    <Button size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); setEditor({ role, name: role.name }); }}>
                      <Pencil size={13} />
                    </Button>
                    <Button size="xs" variant="ghost" colorPalette="red" onClick={(e) => { e.stopPropagation(); void requestDelete(role); }}>
                      <Trash2 size={13} />
                    </Button>
                  </Flex>
                )}
              </Flex>
            ))}
            {!roles.length && (
              <Text py="6" textAlign="center" color="gray.400" fontSize="sm">No hay roles.</Text>
            )}
          </Stack>
        </Box>

        {/* Panel derecho: permisos del rol seleccionado */}
        <Box flex="1" minW="0">
          {selected ? (
            <>
              <Flex justify="space-between" align="center" mb="5" wrap="wrap" gap="3">
                <Box>
                  <Heading size="md">{selected.name}</Heading>
                  {selected.is_system ? (
                    <Text fontSize="sm" color="gray.500" mt="1">Rol del sistema. Puedes editar sus permisos.</Text>
                  ) : null}
                </Box>
                <Button colorPalette="purple" loading={saving} onClick={() => void savePermissions()}>
                  <Check size={17} />Guardar permisos
                </Button>
              </Flex>

              <Stack gap="5">
                {MODULE_ORDER.map((module) => {
                  const defs = PERMISSION_DEFS.filter((p) => p.module === module);
                  if (!defs.length) return null;
                  return (
                    <Box key={module} bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="5">
                      <Text fontWeight="bold" fontSize="xs" color="gray.500" mb="3">
                        {MODULE_LABELS[module]?.toUpperCase()}
                      </Text>
                      <Stack gap="3">
                        {defs.map((def) => (
                          <Checkbox.Root
                            key={def.code}
                            checked={permissions.includes(def.code)}
                            onCheckedChange={() => togglePermission(def.code)}
                          >
                            <Checkbox.HiddenInput />
                            <Checkbox.Control />
                            <Checkbox.Label>
                              <Text fontSize="sm">{def.label}</Text>
                            </Checkbox.Label>
                          </Checkbox.Root>
                        ))}
                      </Stack>
                    </Box>
                  );
                })}
              </Stack>

              <Flex justify="end" mt="6">
                <Button colorPalette="purple" loading={saving} onClick={() => void savePermissions()}>
                  <Check size={17} />Guardar permisos
                </Button>
              </Flex>
            </>
          ) : (
            <Flex h="300px" align="center" justify="center">
              <Text color="gray.400">Selecciona un rol para ver y editar sus permisos.</Text>
            </Flex>
          )}
        </Box>
      </Flex>

      {/* Modal crear/renombrar rol */}
      {editor ? (
        <Modal title={editor.role ? "Renombrar rol" : "Nuevo rol"} onClose={() => setEditor(null)}>
          <Stack gap="4">
            <Box>
              <Text mb="2" fontSize="sm" fontWeight="semibold">Nombre del rol *</Text>
              <Input
                autoFocus
                value={editor.name}
                placeholder="Ej: Almacenista, Cajero..."
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") void saveRole(); }}
              />
            </Box>
            <Flex justify="end" gap="3">
              <Button variant="outline" onClick={() => setEditor(null)}>Cancelar</Button>
              <Button colorPalette="purple" onClick={() => void saveRole()}>
                <Check size={17} />Guardar
              </Button>
            </Flex>
          </Stack>
        </Modal>
      ) : null}

      {/* Modal confirmar eliminacion */}
      {deleting ? (
        <Modal title="Eliminar rol" onClose={() => { setDeleting(null); setBlockedUsers(null); }}>
          {blockedUsers && blockedUsers.length > 0 ? (
            <>
              <Text color="gray.600" mb="3">
                No puedes eliminar el rol <strong>{deleting.name}</strong> porque tiene {blockedUsers.length} usuario{blockedUsers.length > 1 ? "s" : ""} asignado{blockedUsers.length > 1 ? "s" : ""}. Cambia su rol antes de eliminar.
              </Text>
              <Stack gap="1" maxH="200px" overflowY="auto" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="3">
                {blockedUsers.map((u) => (
                  <Text key={u.username} fontSize="sm" fontFamily="mono">
                    {u.display_name ? `${u.display_name} (${u.username})` : u.username}
                  </Text>
                ))}
              </Stack>
              <Flex justify="end" mt="5">
                <Button colorPalette="purple" onClick={() => { setDeleting(null); setBlockedUsers(null); }}>Entendido</Button>
              </Flex>
            </>
          ) : (
            <>
              <Text color="gray.600">
                Eliminar el rol <strong>{deleting.name}</strong>? Esta accion no se puede deshacer.
              </Text>
              <Flex justify="end" gap="3" mt="6">
                <Button variant="outline" onClick={() => setDeleting(null)}>Cancelar</Button>
                <Button colorPalette="red" onClick={() => void confirmDelete()}>
                  <Trash2 size={17} />Eliminar
                </Button>
              </Flex>
            </>
          )}
        </Modal>
      ) : null}
    </Box>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5">
      <Box w="full" maxW="460px" bg="white" borderRadius="md" p="6" boxShadow="2xl">
        <Flex justify="space-between" align="center" mb="5">
          <Heading size="md">{title}</Heading>
          <Button size="sm" variant="ghost" onClick={onClose}><X size={17} /></Button>
        </Flex>
        {children}
      </Box>
    </Flex>
  );
}
