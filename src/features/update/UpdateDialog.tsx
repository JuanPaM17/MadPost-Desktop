import { Box, Button, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Download, X } from "lucide-react";
import { useState } from "react";
import type { UpdateInfo } from "./UpdateService";

export function UpdateDialog({ update, onOmit, onInstall }: { update: UpdateInfo; onOmit?: () => void; onInstall: () => Promise<void> }) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  async function install() {
    setInstalling(true);
    setError("");
    try { await onInstall(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "No fue posible iniciar la actualizacion."); setInstalling(false); }
  }

  return (
    <Flex position="fixed" zIndex="modal" inset="0" bg="blackAlpha.600" align="center" justify="center" p="6">
      <Box w="full" maxW="560px" bg="white" borderRadius="md" boxShadow="2xl" p="8">
        <Stack gap="5">
          <Box>
            <Text color={update.forced ? "red.600" : "#6366f1"} fontWeight="bold" fontSize="sm">
              {update.forced ? "ACTUALIZACION OBLIGATORIA" : "ACTUALIZACION DISPONIBLE"}
            </Text>
            <Heading mt="1" size="xl">Nueva version v{update.version}</Heading>
          </Box>
          {update.forced && (
            <Flex gap="3" p="4" bg="red.50" borderWidth="1px" borderColor="red.200" borderRadius="md" align="start">
              <AlertTriangle size={18} color="#991b1b" style={{ flexShrink: 0, marginTop: 2 }} />
              <Text color="red.800" fontSize="sm" fontWeight="semibold">
                Esta version ya no es compatible con MadPost. Debes instalar la actualizacion para continuar usando la aplicacion.
              </Text>
            </Flex>
          )}
          {update.releaseNotes ? (
            <Box maxH="180px" overflowY="auto" bg="gray.50" borderWidth="1px" borderColor="gray.200" p="4" whiteSpace="pre-wrap" fontSize="sm">
              {update.releaseNotes}
            </Box>
          ) : null}
          {error ? <Text color="red.600" fontSize="sm">{error}</Text> : null}
          <Flex justify="end" gap="3">
            {!update.forced && onOmit && (
              <Button variant="outline" disabled={installing} onClick={onOmit}>
                <X size={16} />Omitir
              </Button>
            )}
            <Button colorPalette={update.forced ? "red" : "purple"} disabled={installing || !update.downloadUrl} onClick={() => void install()}>
              <Download size={16} />{installing ? "Descargando..." : "Instalar ahora"}
            </Button>
          </Flex>
        </Stack>
      </Box>
    </Flex>
  );
}
