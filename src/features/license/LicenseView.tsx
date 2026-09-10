import { Alert, Badge, Box, Button, Flex, Heading, Input, Stack, Text } from "@chakra-ui/react";
import { useState, useEffect, type FormEvent, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { migrationService, type MigrationProgress } from "../migration/MigrationService";

type Props = { online: boolean | null; onActivate: (key: string) => Promise<void>; onRetry: () => Promise<void> };

export function LicenseView({ online, onActivate, onRetry }: Props) {
  const [key, setKey] = useState(""); const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [showMigrate, setShowMigrate] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migProgress, setMigProgress] = useState<MigrationProgress | null>(null);
  const [migDone, setMigDone] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const disabled = online === false || submitting;

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => {});
    void (async () => {
      try {
        const { appDataDir, join } = await import("@tauri-apps/api/path");
        const path = await join(await appDataDir(), "..", "MadPost", "madpost.db");
        console.log("[Migration] Java DB path:", path);
        const exists = await migrationService.javaDbExists();
        console.log("[Migration] javaDbExists:", exists);
        const already = await migrationService.isMigrated();
        console.log("[Migration] isMigrated:", already);
        setShowMigrate(exists && !already);
      } catch (err) {
        console.error("[Migration] useEffect error:", err);
      }
    })();
  }, []);

  async function startMigration() {
    console.log("[Migration] startMigration called");
    setMigrating(true);
    setMigProgress(null);
    const ok = await migrationService.migrate((p) => { console.log("[Migration] progress:", p); setMigProgress(p); });
    console.log("[Migration] migrate result:", ok);
    setMigrating(false);
    if (ok) {
      setShowMigrate(false);
      setMigDone(true);
      let secs = 5;
      const interval = setInterval(() => {
        secs -= 1;
        setCountdown(secs);
        if (secs <= 0) { clearInterval(interval); window.location.reload(); }
      }, 1000);
    }
  }
  async function activate() { setError(""); setSubmitting(true); try { await onActivate(key); } catch (reason) { setError(reason instanceof Error ? reason.message : "No fue posible activar la licencia."); } finally { setSubmitting(false); } }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!disabled && key.trim()) void activate(); }
  return <AuthFrame activeStep={1}><form onSubmit={submit} style={{ width: "100%", maxWidth: "430px" }}><Stack gap="6"><Box><Badge colorPalette="purple" mb="3">PRIMER ACCESO</Badge><Heading size="2xl">Activar licencia</Heading><Text mt="2" color="gray.600">Ingresa tu clave para desbloquear el sistema.</Text></Box>
    {online === false ? <Alert.Root status="warning"><Alert.Indicator /><Alert.Content><Alert.Title>Sin conexion a internet</Alert.Title><Alert.Description>La primera activacion requiere conexion.</Alert.Description></Alert.Content><Button size="sm" variant="outline" onClick={onRetry}>Reintentar</Button></Alert.Root> : null}
    {migDone ? <Alert.Root status="success"><Alert.Indicator /><Alert.Content><Alert.Title>Migracion completada</Alert.Title><Alert.Description>Los datos fueron importados correctamente. La app se reiniciara en {countdown} segundo{countdown !== 1 ? "s" : ""}...</Alert.Description></Alert.Content></Alert.Root> : null}
    {showMigrate ? <Box p="4" borderWidth="1px" borderColor="purple.200" bg="purple.50" borderRadius="md"><Text fontWeight="semibold" mb="1">Datos legacy detectados</Text><Text fontSize="sm" color="gray.600" mb="3">Se encontro una instalacion legacy de MadPost. Puedes importar todos tus datos antes de activar la licencia.</Text>{migrating ? <><Text fontSize="sm" color="gray.500" mb="2">{migProgress?.phase === "copying" ? `Copiando... ${migProgress.percent}%` : migProgress?.phase === "checking" ? "Verificando..." : migProgress?.phase === "error" ? `Error: ${migProgress.message}` : "Procesando..."}</Text><Box w="full" h="6px" bg="gray.200" borderRadius="full" overflow="hidden"><Box h="full" bg="#6366f1" borderRadius="full" style={{ width: `${migProgress?.phase === "copying" ? migProgress.percent : 0}%`, transition: "width 0.3s ease" }} /></Box></> : <Button colorPalette="purple" variant="outline" size="sm" onClick={startMigration}>Importar datos de MadPost</Button>}</Box> : null}
    <Stack gap="2"><Text fontWeight="semibold">Clave de licencia</Text><Input value={key} onChange={(event) => setKey(event.target.value)} disabled={disabled} placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" fontFamily="mono" /></Stack>
    {error ? <Text color="red.600" fontSize="sm">{error}</Text> : null}<Button type="submit" colorPalette="purple" size="lg" disabled={disabled || !key.trim()}>{submitting ? "Verificando..." : "Activar licencia"}</Button><Text color="gray.400" fontSize="xs">MadPost POS{appVersion ? ` v${appVersion}` : ""}</Text></Stack></form></AuthFrame>;
}

export function AuthFrame({ activeStep, children }: { activeStep: number; children: ReactNode }) {
  const steps = ["Activa tu licencia", "Crea tu cuenta admin", "Configura tu negocio"];
  return <Flex minH="100vh" bg="white"><Flex w="full" minH="100vh" bg="white" overflow="hidden" direction={{ base: "column", md: "row" }}><Box w={{ base: "full", md: "310px" }} minH={{ base: "auto", md: "100vh" }} p={{ base: "8", md: "10" }} color="white" background="linear-gradient(to bottom, #4f46e5, #6366f1)"><Heading size="2xl">MadPost</Heading><Text mt="1" color="whiteAlpha.800">Sistema de Punto de Venta</Text><Box w="12" h="1px" bg="whiteAlpha.700" my="10" /><Stack gap="5">{steps.map((step, index) => { const number = index + 1; return <Flex key={step} gap="3" align="center" opacity={number > activeStep ? 0.65 : 1} fontWeight={number === activeStep ? "bold" : "medium"}><Flex w="7" h="7" align="center" justify="center" borderWidth="1px" borderColor="whiteAlpha.700" bg={number === activeStep ? "whiteAlpha.300" : "transparent"}>{number}</Flex><Text>{step}</Text></Flex>; })}</Stack></Box><Flex flex="1" p={{ base: "8", md: "12" }} align="center" justify="center">{children}</Flex></Flex></Flex>;
}
