import { Alert, Badge, Box, Button, Flex, Heading, Input, Stack, Text } from "@chakra-ui/react";
import { useState, useEffect, type FormEvent, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { migrationService } from "../migration/MigrationService";
import { licenseRepository } from "../../infrastructure/sqlite/repositories";

type Props = { online: boolean | null; onActivate: (key: string) => Promise<void>; onRetry: () => Promise<void> };

export function LicenseView({ online, onActivate, onRetry }: Props) {
  const [key, setKey] = useState(""); const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [hadLicense, setHadLicense] = useState(false);
  const disabled = online === false || submitting;

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => {});
    void migrationService.bootCheck();
    void licenseRepository.getAnyCached().then((cached) => { if (cached) setHadLicense(true); });
  }, []);

  async function activate() { setError(""); setSubmitting(true); try { await onActivate(key); } catch (reason) { setError(reason instanceof Error ? reason.message : "No fue posible activar la licencia."); } finally { setSubmitting(false); } }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!disabled && key.trim()) void activate(); }
  return (
    <AuthFrame activeStep={1}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: "430px" }}>
        <Stack gap="6">
          <Box>
            <Badge colorPalette="purple" mb="3">{hadLicense ? "LICENCIA" : "PRIMER ACCESO"}</Badge>
            <Heading size="2xl">{hadLicense ? "Tu licencia expiro" : "Activar licencia"}</Heading>
            <Text mt="2" color="gray.600">
              {hadLicense
                ? "Tu periodo de acceso ha terminado. Ingresa una clave nueva o renovada para continuar."
                : "Ingresa tu clave para desbloquear el sistema."}
            </Text>
          </Box>
          {hadLicense ? (
            <Alert.Root status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Licencia vencida</Alert.Title>
                <Alert.Description>Contacta a tu proveedor para renovar o adquirir una nueva licencia.</Alert.Description>
              </Alert.Content>
            </Alert.Root>
          ) : null}
          {online === false ? (
            <Alert.Root status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Sin conexion a internet</Alert.Title>
                <Alert.Description>La activacion requiere conexion.</Alert.Description>
              </Alert.Content>
              <Button size="sm" variant="outline" onClick={onRetry}>Reintentar</Button>
            </Alert.Root>
          ) : null}
          <Stack gap="2">
            <Text fontWeight="semibold">Clave de licencia</Text>
            <Input value={key} onChange={(e) => setKey(e.target.value)} disabled={disabled} placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" fontFamily="mono" />
          </Stack>
          {error ? <Text color="red.600" fontSize="sm">{error}</Text> : null}
          <Button type="submit" colorPalette="purple" size="lg" disabled={disabled || !key.trim()}>{submitting ? "Verificando..." : "Activar licencia"}</Button>
          <Text color="gray.400" fontSize="xs">MadPost POS{appVersion ? ` v${appVersion}` : ""}</Text>
        </Stack>
      </form>
    </AuthFrame>
  );
}

export function AuthFrame({ activeStep, children }: { activeStep: number; children: ReactNode }) {
  const steps = ["Activa tu licencia", "Crea tu cuenta admin", "Configura tu negocio"];
  return <Flex minH="100vh" bg="white"><Flex w="full" minH="100vh" bg="white" overflow="hidden" direction={{ base: "column", md: "row" }}><Box w={{ base: "full", md: "310px" }} minH={{ base: "auto", md: "100vh" }} p={{ base: "8", md: "10" }} color="white" background="linear-gradient(to bottom, #4f46e5, #6366f1)"><Heading size="2xl">MadPost</Heading><Text mt="1" color="whiteAlpha.800">Sistema de Punto de Venta</Text><Box w="12" h="1px" bg="whiteAlpha.700" my="10" /><Stack gap="5">{steps.map((step, index) => { const number = index + 1; return <Flex key={step} gap="3" align="center" opacity={number > activeStep ? 0.65 : 1} fontWeight={number === activeStep ? "bold" : "medium"}><Flex w="7" h="7" align="center" justify="center" borderWidth="1px" borderColor="whiteAlpha.700" bg={number === activeStep ? "whiteAlpha.300" : "transparent"}>{number}</Flex><Text>{step}</Text></Flex>; })}</Stack></Box><Flex flex="1" p={{ base: "8", md: "12" }} align="center" justify="center">{children}</Flex></Flex></Flex>;
}
