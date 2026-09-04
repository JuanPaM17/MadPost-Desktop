import { Badge, Box, Button, Flex, Heading, Input, Stack, Text } from "@chakra-ui/react";
import { Check, Pencil, Save, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import type { LocalUser } from "../../core/types";
import { authService } from "./AuthService";

export function ProfileView({ user, onUpdated }: { user: LocalUser; onUpdated: (user: LocalUser) => void }) {
  const [name, setName] = useState(user.display_name || "");
  const [username, setUsername] = useState(user.username);
  const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const displayName = user.display_name || user.username;

  async function save() {
    setMessage(""); setError("");
    if (!username.trim()) { setError("El nombre de usuario es obligatorio."); return; }
    if (!name.trim()) { setError("El nombre para mostrar es obligatorio."); return; }
    if (password && password.length < 4) { setError("La contrasena debe tener al menos 4 caracteres."); return; }
    if (password && password !== confirmation) { setError("Las contrasenas no coinciden."); return; }
    setSaving(true);
    try {
      const updated = await authService.updateProfile(user, username, name, password || null);
      onUpdated(updated); setPassword(""); setConfirmation(""); setMessage("Perfil actualizado."); setEditing(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "No fue posible actualizar el perfil."); }
    finally { setSaving(false); }
  }

  function cancel() { setUsername(user.username); setName(user.display_name || ""); setPassword(""); setConfirmation(""); setError(""); setEditing(false); }

  return <Box w="full" maxW="1100px" mx="auto">
    <Flex align="center" gap="4" mb="8"><Flex w="76px" h="76px" borderRadius="full" bg="#6366f1" color="white" align="center" justify="center" fontSize="28px" fontWeight="bold">{displayName.charAt(0).toUpperCase()}</Flex><Box><Heading size="lg">{displayName}</Heading><Text color="gray.500">@{user.username}</Text><RoleBadge role={user.role} /></Box><Box ml="auto" textAlign="right">{message ? <Flex color="#10b981" gap="2" align="center" justify="end" fontWeight="semibold" mb="2"><Check size={18} />{message}</Flex> : null}{error ? <Text color="#ef4444" fontWeight="semibold" mb="2">{error}</Text> : null}<Button variant={editing ? "outline" : "solid"} colorPalette="purple" onClick={() => editing ? cancel() : setEditing(true)} disabled={saving}>{editing ? <><X size={17} />Cancelar</> : <><Pencil size={17} />Editar perfil</>}</Button></Box></Flex>
    <Flex gap="6" direction={{ base: "column", lg: "row" }}><Box flex="1" bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="6"><Heading size="md">Informacion personal</Heading><Stack gap="5" mt="6">{editing ? <Box><Text mb="2" fontWeight="semibold" fontSize="sm">Usuario</Text><Input value={username} placeholder="Nombre de usuario" onChange={(event) => setUsername(event.target.value)} /></Box> : <ReadOnly label="Usuario" value={user.username} />}{editing ? <Box><Text mb="2" fontWeight="semibold" fontSize="sm">Nombre para mostrar</Text><Input value={name} placeholder="Tu nombre completo" onChange={(event) => setName(event.target.value)} /></Box> : <ReadOnly label="Nombre para mostrar" value={displayName} />}<ReadOnly label="Rol" value={roleLabel(user.role)} /></Stack></Box>
      <Box flex="1" bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" p="6"><Flex align="center" gap="2"><ShieldCheck size={19} color="#6366f1" /><Heading size="md">Seguridad</Heading></Flex>{editing ? <><Text mt="2" color="gray.500" fontSize="sm">Deja en blanco si no deseas cambiar la contrasena.</Text><Stack gap="5" mt="6"><Box><Text mb="2" fontWeight="semibold" fontSize="sm">Nueva contrasena</Text><Input type="password" value={password} placeholder="Nueva contrasena (min. 4 caracteres)" onChange={(event) => setPassword(event.target.value)} /></Box><Box><Text mb="2" fontWeight="semibold" fontSize="sm">Confirmar contrasena</Text><Input type="password" value={confirmation} placeholder="Confirmar nueva contrasena" onChange={(event) => setConfirmation(event.target.value)} /></Box></Stack></> : <Stack gap="5" mt="6"><ReadOnly label="Contrasena" value="Configurada" /><Text color="gray.500" fontSize="sm">Puedes actualizarla desde Editar perfil.</Text></Stack>}</Box>
    </Flex>{editing ? <Flex justify="end" mt="6"><Button colorPalette="purple" disabled={saving} onClick={() => void save()}><Save size={18} />{saving ? "Guardando..." : "Guardar cambios"}</Button></Flex> : null}
  </Box>;
}

function ReadOnly({ label, value }: { label: string; value: string }) { return <Box><Text color="gray.500" fontSize="xs" fontWeight="bold">{label.toUpperCase()}</Text><Text mt="1" fontWeight="semibold">{value}</Text></Box>; }
function RoleBadge({ role }: { role: LocalUser["role"] }) { return <Badge mt="2" colorPalette={role === "SELLER" ? "green" : "purple"}>{roleLabel(role)}</Badge>; }
function roleLabel(role: LocalUser["role"]) { return role === "SUPERADMIN" ? "Super Admin" : role === "ADMIN" ? "Administrador" : "Vendedor"; }
