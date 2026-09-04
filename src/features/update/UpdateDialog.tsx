import { Box, Button, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { Download, X } from "lucide-react";
import { useState } from "react";
import type { UpdateInfo } from "./UpdateService";

export function UpdateDialog({ update, onOmit, onInstall }: { update: UpdateInfo; onOmit: () => void; onInstall: () => Promise<void> }) {
  const [installing, setInstalling] = useState(false); const [error, setError] = useState("");
  async function install() { setInstalling(true); setError(""); try { await onInstall(); } catch (reason) { setError(reason instanceof Error ? reason.message : "No fue posible iniciar la actualizacion."); setInstalling(false); } }
  return <Flex position="fixed" zIndex="modal" inset="0" bg="blackAlpha.600" align="center" justify="center" p="6"><Box w="full" maxW="560px" bg="white" borderRadius="md" boxShadow="2xl" p="8"><Stack gap="5"><Box><Text color="#6366f1" fontWeight="bold" fontSize="sm">ACTUALIZACION DISPONIBLE</Text><Heading mt="1" size="xl">Nueva version v{update.version}</Heading><Text mt="2" color="gray.600">Hay una actualizacion lista para instalar. Los servicios de sesion se iniciaran cuando la omitas o despues de reiniciar.</Text></Box>{update.releaseNotes ? <Box maxH="180px" overflowY="auto" bg="gray.50" borderWidth="1px" borderColor="gray.200" p="4" whiteSpace="pre-wrap" fontSize="sm">{update.releaseNotes}</Box> : null}{error ? <Text color="red.600" fontSize="sm">{error}</Text> : null}<Flex justify="end" gap="3"><Button variant="outline" disabled={installing} onClick={onOmit}><X size={16} />Omitir</Button><Button colorPalette="purple" disabled={installing || !update.downloadUrl} onClick={() => void install()}><Download size={16} />{installing ? "Descargando..." : "Instalar ahora"}</Button></Flex></Stack></Box></Flex>;
}
