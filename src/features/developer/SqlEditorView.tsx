import { Box, Button, Flex, Heading, Input, Separator, Stack, Table, Text, Textarea } from "@chakra-ui/react";
import { Clipboard, Eraser, Play, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";

type ResultRow = Record<string, unknown>;
type MenuState = { x: number; y: number; table?: string; row?: ResultRow; cell?: unknown } | null;

export function SqlEditorView() {
  const [tables, setTables] = useState<string[]>([]); const [sql, setSql] = useState("");
  const [columns, setColumns] = useState<string[]>([]); const [rows, setRows] = useState<ResultRow[]>([]);
  const [status, setStatus] = useState<{ message: string; error: boolean } | null>(null);
  const [filter, setFilter] = useState(""); const [menu, setMenu] = useState<MenuState>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { void loadTables(); }, []);

  async function loadTables() {
    const database = await databaseManager.database();
    const result = await database.select<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    setTables(result.map((entry) => entry.name));
  }

  async function runQuery(preparedSql?: string) {
    const editor = editorRef.current;
    const selected = editor && editor.selectionStart !== editor.selectionEnd ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : "";
    const source = (preparedSql ?? (selected || sql)).trim();
    if (!source) { setStatus({ message: "Escribe una consulta para ejecutarla.", error: true }); return; }
    const startedAt = performance.now(); setStatus(null); setMenu(null);
    try {
      const statements = source.split(";").map((statement) => statement.trim()).filter(Boolean);
      const writes = statements.filter((statement) => !isReadStatement(statement));
      const reads = statements.filter(isReadStatement);
      const database = await databaseManager.database(); let affected = 0;
      for (const statement of writes) { const result = await database.execute(statement); affected += result.rowsAffected; }
      if (reads.length) {
        const result = await database.select<ResultRow[]>(reads.at(-1)!);
        const resultColumns = result.length ? Object.keys(result[0]) : inferColumns(reads.at(-1)!);
        setColumns(resultColumns); setRows(result);
        setStatus({ message: `${result.length} fila(s) en ${elapsed(startedAt)}ms`, error: false });
      } else {
        setColumns([]); setRows([]);
        setStatus({ message: `OK - ${writes.length} sentencia(s) ejecutada(s), ${affected} fila(s) afectada(s) en ${elapsed(startedAt)}ms`, error: false });
        await loadTables();
      }
    } catch (error) { setStatus({ message: `Error: ${error instanceof Error ? error.message : String(error)}`, error: true }); }
  }

  function queryTable(table: string, count = false) { const query = count ? `SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)};` : `SELECT * FROM ${quoteIdentifier(table)} ORDER BY rowid DESC LIMIT 100;`; setSql(query); void runQuery(query); }
  function clear() { setSql(""); setColumns([]); setRows([]); setStatus(null); editorRef.current?.focus(); }
  async function copyResults() { if (!columns.length) return; await copyText([columns.join("\t"), ...rows.map((row) => columns.map((column) => formatValue(row[column])).join("\t"))].join("\n")); setStatus({ message: "Resultados copiados al portapapeles.", error: false }); }
  const visibleTables = tables.filter((table) => table.toLowerCase().includes(filter.toLowerCase()));

  return <Flex h="full" minH="620px" bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden" onClick={() => setMenu(null)}>
    <Flex w="180px" minW="120px" direction="column" bg="gray.50"><Flex p="3" align="center" gap="2"><Search size={16} color="#6366f1" /><Text fontSize="sm" fontWeight="bold">Tablas</Text></Flex><Box px="3" pb="3"><Input size="sm" placeholder="Buscar" value={filter} onChange={(event) => setFilter(event.target.value)} /></Box><Separator /><Box className="sidebar-scroll" overflowY="auto" flex="1" py="2">{visibleTables.map((table) => <Button key={table} w="full" justifyContent="start" variant="ghost" fontFamily="mono" fontSize="xs" borderRadius="0" onDoubleClick={() => queryTable(table)} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, table }); }}>{table}</Button>)}</Box></Flex>
    <Separator orientation="vertical" />
    <Flex flex="1" minW="0" direction="column"><Box flex="0 0 35%" minH="230px" p="5"><Flex justify="space-between" align="center" mb="3"><Heading size="sm">Consulta SQL</Heading><Flex gap="2"><Button size="sm" colorPalette="purple" onClick={() => void runQuery()}><Play size={16} />Ejecutar</Button><Button size="sm" variant="outline" onClick={clear}><Eraser size={16} />Limpiar</Button><Button size="sm" variant="outline" disabled={!columns.length} onClick={() => void copyResults()}><Clipboard size={16} />Copiar resultados</Button></Flex></Flex><Textarea ref={editorRef} h="calc(100% - 38px)" minH="150px" resize="none" wrap="off" fontFamily="Consolas, 'Courier New', monospace" placeholder={"Escribe tu consulta SQL aqui...\nCtrl+Enter para ejecutar"} value={sql} onChange={(event) => setSql(event.target.value)} onKeyDown={(event) => { if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); void runQuery(); } }} /></Box>
      <Separator />
      <Flex flex="1" minH="0" direction="column" p="5"><Flex minH="24px" mb="2" align="center"><Text fontSize="sm" color={status?.error ? "red.600" : "#10b981"}>{status?.message ?? ""}</Text></Flex><Box flex="1" overflow="auto" borderWidth="1px" borderColor="gray.200">{columns.length ? <Table.Root size="sm" variant="line" minW="max-content"><Table.Header><Table.Row>{columns.map((column) => <Table.ColumnHeader key={column} minW="140px">{column}</Table.ColumnHeader>)}</Table.Row></Table.Header><Table.Body>{rows.map((row, rowIndex) => <Table.Row key={rowIndex}>{columns.map((column) => <Table.Cell key={column} minW="140px" onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, row, cell: row[column] }); }}>{formatValue(row[column])}</Table.Cell>)}</Table.Row>)}</Table.Body></Table.Root> : <Flex h="full" minH="200px" align="center" justify="center"><Text color="gray.500">Sin resultados</Text></Flex>}</Box></Flex>
    </Flex>
    {menu?.table ? <ContextMenu x={menu.x} y={menu.y}><Button variant="ghost" justifyContent="start" onClick={() => queryTable(menu.table!)}><Search size={16} />Consultar tabla</Button><Button variant="ghost" justifyContent="start" onClick={() => queryTable(menu.table!, true)}><Search size={16} />Contar filas</Button></ContextMenu> : null}
    {menu?.row ? <ContextMenu x={menu.x} y={menu.y}><Button variant="ghost" justifyContent="start" onClick={() => void copyText(formatValue(menu.cell))}><Clipboard size={16} />Copiar celda</Button><Button variant="ghost" justifyContent="start" onClick={() => void copyText(columns.map((column) => formatValue(menu.row![column])).join("\t"))}><Clipboard size={16} />Copiar fila</Button></ContextMenu> : null}
  </Flex>;
}

function ContextMenu({ x, y, children }: { x: number; y: number; children: React.ReactNode }) { return <Stack position="fixed" zIndex="popover" left={`${x}px`} top={`${y}px`} minW="180px" gap="0" p="1" bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" boxShadow="lg" onClick={(event) => event.stopPropagation()}>{children}</Stack>; }
function isReadStatement(statement: string) { return /^(SELECT|PRAGMA|EXPLAIN)\b/i.test(statement); }
function quoteIdentifier(identifier: string) { return `"${identifier.replaceAll('"', '""')}"`; }
function elapsed(startedAt: number) { return Math.round(performance.now() - startedAt); }
function formatValue(value: unknown) { return value === null || value === undefined ? "" : String(value); }
function inferColumns(sql: string) { const aliases = /select\s+(.+?)\s+from/i.exec(sql)?.[1]; return aliases ? aliases.split(",").map((part) => part.trim().split(/\s+as\s+/i).at(-1) ?? part.trim()) : []; }
async function copyText(value: string) { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; } const textarea = document.createElement("textarea"); textarea.value = value; document.body.append(textarea); textarea.select(); document.execCommand("copy"); textarea.remove(); }
