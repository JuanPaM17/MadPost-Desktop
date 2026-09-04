import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ScrollableSelect } from "./ScrollableSelect";

export function PaginationControls({ total, page, pageSize, onPageChange, onPageSizeChange }: { total: number; page: number; pageSize: number; onPageChange: (page: number) => void; onPageSizeChange: (size: number) => void }) {
  const pageCount = Math.max(1, pageSize ? Math.ceil(total / pageSize) : 1);
  return <Flex px="5" py="4" borderTopWidth="1px" borderColor="gray.100" align="center" justify="space-between" gap="4" wrap="wrap"><Box w="100px"><ScrollableSelect showSearch={false} value={String(pageSize)} placeholder="10" options={[{ value: "10", label: "10" }, { value: "25", label: "25" }, { value: "0", label: "Todas" }]} onValueChange={(value) => onPageSizeChange(Number(value))} /></Box><Text color="gray.500" fontSize="sm">Pagina {page} de {pageCount} ({total} registros)</Text><Flex gap="2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={17} />Anterior</Button><Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>Siguiente<ChevronRight size={17} /></Button></Flex></Flex>;
}
