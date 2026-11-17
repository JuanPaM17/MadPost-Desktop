import { Box, Button, Flex, Progress, Spinner, Stack, Text } from "@chakra-ui/react";
import { CheckCircle2, X, XCircle } from "lucide-react";

export type StepStatus = "idle" | "running" | "ok" | "error";

export type InstallStep = {
  label: string;
  status: StepStatus;
  logs: string[];
};

export type LogEntry = { text: string; ok: boolean | null };

export const INSTALL_STEP_LABELS = [
  "Crear copia de seguridad",
  "Descargar actualizacion",
  "Instalar",
  "Relanzar aplicacion",
] as const;

export function makeInitialSteps(): InstallStep[] {
  return INSTALL_STEP_LABELS.map((label) => ({ label, status: "idle", logs: [] }));
}

export function StepIcon({ status, number }: { status: StepStatus; number: number }) {
  if (status === "running") return <Flex w="28px" h="28px" borderRadius="full" bg="purple.50" color="#6366f1" align="center" justify="center" flexShrink="0"><Spinner size="xs" color="#6366f1" /></Flex>;
  if (status === "ok") return <Flex w="28px" h="28px" borderRadius="full" bg="green.50" color="green.500" align="center" justify="center" flexShrink="0"><CheckCircle2 size={16} /></Flex>;
  if (status === "error") return <Flex w="28px" h="28px" borderRadius="full" bg="red.50" color="red.500" align="center" justify="center" flexShrink="0"><XCircle size={16} /></Flex>;
  return <Flex w="28px" h="28px" borderRadius="full" bg="gray.100" color="gray.400" align="center" justify="center" flexShrink="0"><Text fontSize="xs" fontWeight="bold" color="gray.400">{number}</Text></Flex>;
}

export function LogsModal({ title, logs, onClose }: { title: string; logs: LogEntry[]; onClose: () => void }) {
  return <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.600" align="center" justify="center" p="5" onClick={onClose}>
    <Box w="full" maxW="480px" bg="white" borderRadius="md" p="6" boxShadow="2xl" onClick={(e) => e.stopPropagation()}>
      <Flex justify="space-between" align="center" mb="4">
        <Text fontWeight="bold" fontSize="md">{title}</Text>
        <Button size="sm" variant="ghost" onClick={onClose}><X size={16} /></Button>
      </Flex>
      <Stack gap="2">
        {logs.map((log, i) => (
          <Flex key={i} align="start" gap="3">
            <Box w="28px" flexShrink="0" pt="0.5">
              <Text fontSize="xs" fontWeight="bold" color={log.ok === true ? "green.500" : log.ok === false ? "red.500" : "gray.400"}>
                {log.ok === true ? "OK" : log.ok === false ? "ERR" : "--"}
              </Text>
            </Box>
            <Text fontSize="sm" color={log.ok === false ? "red.600" : "gray.700"} lineHeight="1.6">{log.text}</Text>
          </Flex>
        ))}
      </Stack>
      <Button mt="5" w="full" variant="outline" onClick={onClose}>Cerrar</Button>
    </Box>
  </Flex>;
}

export function StepsList({
  steps,
  downloadedBytes,
  totalBytes,
  onSelectStep,
}: {
  steps: InstallStep[];
  downloadedBytes: number;
  totalBytes: number | null;
  onSelectStep: (index: number) => void;
}) {
  const progressPercent = totalBytes && totalBytes > 0
    ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
    : null;

  return (
    <Stack gap="3">
      {steps.map((step, i) => (
        <Flex
          key={i}
          align="center"
          gap="3"
          cursor={step.logs.length > 0 ? "pointer" : "default"}
          onClick={() => step.logs.length > 0 ? onSelectStep(i) : undefined}
          _hover={step.logs.length > 0 ? { bg: "gray.50" } : {}}
          borderRadius="md"
          p="2"
          mx="-2"
        >
          <StepIcon status={step.status} number={i + 1} />
          <Box flex="1">
            <Text fontSize="sm" fontWeight="medium" color={
              step.status === "error" ? "red.600"
              : step.status === "ok" ? "green.600"
              : step.status === "running" ? "#6366f1"
              : "gray.500"
            }>
              {step.label}
            </Text>
            {step.status === "running" && i === 1 && progressPercent !== null ? (
              <Box mt="1">
                <Progress.Root value={progressPercent} size="xs" colorPalette="purple">
                  <Progress.Track><Progress.Range /></Progress.Track>
                </Progress.Root>
                <Text fontSize="xs" color="gray.400" mt="0.5">{progressPercent}%</Text>
              </Box>
            ) : null}
          </Box>
          {step.logs.length > 0 ? <Text fontSize="xs" color="gray.400">ver</Text> : null}
        </Flex>
      ))}
    </Stack>
  );
}

export function UpdateStepsModal({
  version,
  releaseNotes,
  steps,
  downloadedBytes,
  totalBytes,
  onClose,
}: {
  version: string;
  releaseNotes: string | null;
  steps: InstallStep[];
  downloadedBytes: number;
  totalBytes: number | null;
  onClose?: () => void;
}) {
  const [selectedStep, setSelectedStep] = React.useState<number | null>(null);
  const hasError = steps.some((s) => s.status === "error");
  const allDone = steps.every((s) => s.status === "ok");

  return <Flex position="fixed" inset="0" zIndex="modal" bg="blackAlpha.700" align="center" justify="center" p="5">
    <Box w="full" maxW="440px" bg="white" borderRadius="lg" p="6" boxShadow="2xl">
      <Flex justify="space-between" align="center" mb="1">
        <Text fontWeight="bold" fontSize="md">Actualizando a v{version}</Text>
        {(hasError || allDone) && onClose ? (
          <Button size="sm" variant="ghost" onClick={onClose}><X size={16} /></Button>
        ) : null}
      </Flex>
      {releaseNotes ? (
        <Text fontSize="xs" color="gray.500" mb="4" overflow="hidden" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{releaseNotes}</Text>
      ) : null}
      <StepsList
        steps={steps}
        downloadedBytes={downloadedBytes}
        totalBytes={totalBytes}
        onSelectStep={setSelectedStep}
      />
      {hasError ? (
        <Text mt="4" fontSize="xs" color="red.500">Ocurrio un error. Haz clic en "ver" en el paso fallido para mas detalles.</Text>
      ) : null}
    </Box>
    {selectedStep !== null ? (
      <LogsModal
        title={`Paso ${selectedStep + 1}: ${steps[selectedStep].label}`}
        logs={steps[selectedStep].logs.map((t) => ({ text: t, ok: null }))}
        onClose={() => setSelectedStep(null)}
      />
    ) : null}
  </Flex>;
}

import React from "react";
