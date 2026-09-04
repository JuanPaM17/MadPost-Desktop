import { Badge, Box, Button, Flex, Heading, Input, Stack, Text } from "@chakra-ui/react";
import { CircleCheck, KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { RecoveryMode } from "./RecoveryService";

type Props = {
  onRecover: (username: string, code: string, password: string, mode: RecoveryMode) => Promise<void>;
  onBack: () => void;
};

export function RecoveryView({ onRecover, onBack }: Props) {
  const [step, setStep] = useState(1);
  const [username, setUsername] = useState("");
  const [mode, setMode] = useState<RecoveryMode>("local");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function next() {
    if (!username.trim()) { setError("Ingresa tu nombre de usuario."); return; }
    setError(""); setStep(2);
  }

  async function recover() {
    if (!code.trim()) { setError("Ingresa el codigo de recuperacion."); return; }
    if (password.length < 4) { setError("La contrasena debe tener al menos 4 caracteres."); return; }
    if (password !== confirmation) { setError("Las contrasenas no coinciden."); return; }
    setLoading(true); setError("");
    try { await onRecover(username, code, password, mode); setStep(3); } catch (reason) { setError(reason instanceof Error ? reason.message : "No fue posible restablecer la contrasena."); } finally { setLoading(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === 1) next();
    if (step === 2 && !loading) void recover();
  }

  return <Flex minH="100vh" bg="white" direction={{ base: "column", md: "row" }}>
    <Flex w={{ base: "full", md: "310px" }} minH={{ base: "270px", md: "100vh" }} p={{ base: "8", md: "10" }} color="white" direction="column" align="center" justify="center" textAlign="center" background="linear-gradient(to bottom, #4f46e5, #6366f1)">
      <Stack align="center" gap="6"><Flex w="20" h="20" align="center" justify="center" borderWidth="1px" borderColor="whiteAlpha.500" bg="whiteAlpha.200"><KeyRound size={36} /></Flex><Box><Heading size="2xl">Recuperar acceso</Heading><Text mt="3" color="whiteAlpha.800">Sigue los pasos para restablecer tu contrasena.</Text></Box></Stack>
    </Flex>
    <Flex flex="1" minH={{ base: "calc(100vh - 270px)", md: "100vh" }} p={{ base: "8", md: "12" }} align="center" justify="center">
      <form onSubmit={submit} style={{ width: "100%", maxWidth: "500px" }}><Stack w="full" gap="7">
        <RecoveryTabs activeStep={step} />
        {step === 1 ? <Stack gap="6"><Box><Badge colorPalette="purple" mb="3">PASO 1</Badge><Heading size="xl">Identifica tu cuenta</Heading><Text mt="2" color="gray.600">Ingresa el usuario con el que inicias sesion.</Text></Box><Stack gap="2"><Text fontWeight="semibold">Nombre de usuario</Text><Input value={username} onChange={(event) => setUsername(event.target.value)} autoFocus /></Stack><Button type="submit" colorPalette="purple" size="lg">Siguiente</Button></Stack> : null}
        {step === 2 ? <Stack gap="5"><Box><Badge colorPalette="purple" mb="3">PASO 2</Badge><Heading size="xl">Verifica tu identidad</Heading><Text mt="2" color="gray.600">Usa el codigo que recibiste al crear tu cuenta o uno entregado por soporte.</Text></Box><Flex gap="2" p="1" bg="gray.100"><Button type="button" flex="1" variant={mode === "local" ? "solid" : "ghost"} colorPalette={mode === "local" ? "purple" : "gray"} onClick={() => setMode("local")}>Codigo de recuperacion</Button><Button type="button" flex="1" variant={mode === "remote" ? "solid" : "ghost"} colorPalette={mode === "remote" ? "purple" : "gray"} onClick={() => setMode("remote")}>Codigo de soporte</Button></Flex><Text fontSize="sm" color="gray.600">{mode === "local" ? "Codigo guardado al crear la cuenta." : "Requiere conexion a internet."}</Text><Stack gap="2"><Text fontWeight="semibold">Codigo de recuperacion</Text><Input value={code} onChange={(event) => setCode(event.target.value)} /></Stack><Stack gap="2"><Text fontWeight="semibold">Nueva contrasena</Text><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Minimo 4 caracteres" /></Stack><Stack gap="2"><Text fontWeight="semibold">Confirmar contrasena</Text><Input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Stack><Flex justify="space-between"><Button type="button" variant="outline" disabled={loading} onClick={() => setStep(1)}>Anterior</Button><Button type="submit" colorPalette="purple" disabled={loading}>{loading ? "Recuperando..." : "Recuperar"}</Button></Flex></Stack> : null}
        {step === 3 ? <Stack align="center" textAlign="center" gap="5"><Flex w="20" h="20" borderRadius="full" align="center" justify="center" bg="green.100" color="green.600"><CircleCheck size={48} /></Flex><Box><Heading size="xl">Contrasena restablecida</Heading><Text mt="2" color="gray.600">Ya puedes iniciar sesion con tu nueva contrasena.</Text></Box><Button colorPalette="purple" size="lg" w="full" onClick={onBack}>Ir al login</Button></Stack> : null}
        {error ? <Text color="red.600" fontSize="sm" fontWeight="medium">{error}</Text> : null}
        {step !== 3 ? <Button type="button" variant="plain" color="purple.600" alignSelf="center" onClick={onBack}>Volver al inicio de sesion</Button> : null}
      </Stack></form>
    </Flex>
  </Flex>;
}

function RecoveryTabs({ activeStep }: { activeStep: number }) {
  return <Flex gap="0" borderBottomWidth="1px" borderColor="gray.200">{["Usuario", "Codigo", "Listo"].map((label, index) => { const number = index + 1; const active = number === activeStep; return <Box key={label} flex="1" pb="3" textAlign="center" borderBottomWidth="2px" borderColor={active ? "#6366f1" : "transparent"} color={active ? "#4f46e5" : "gray.500"} fontWeight={active ? "bold" : "medium"}>{number}. {label}</Box>; })}</Flex>;
}
