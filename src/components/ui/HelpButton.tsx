import { Box, Flex, Input, Portal, Spinner, Text } from "@chakra-ui/react";
import { ArrowLeft, CircleHelp, Play, Search, X } from "lucide-react";
import { Tip } from "./Tip";
import { useEffect, useMemo, useRef, useState } from "react";
import { appConfig } from "../../config/AppConfig";

type HelpVideo = {
  id: string;
  title: string;
  description: string | null;
  video_key: string;
  thumbnail_key: string | null;
  platform: string;
  screen: string | null;
  position: number;
};

type FetchState = "idle" | "loading" | "ok" | "error";

function r2Url(base: string, key: string) {
  return `${base.replace(/\/$/, "")}/${key}`;
}

function HelpModal({ screen, onClose }: { screen: string; onClose: () => void }) {
  const [state, setState] = useState<FetchState>("loading");
  const [videos, setVideos] = useState<HelpVideo[]>([]);
  const [r2Base, setR2Base] = useState("");
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<HelpVideo | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const url = `${appConfig.baseUrl()}/api/help-videos?screen=${screen}&platform=desktop`;
    fetch(url)
      .then((r) => r.json())
      .then((json) => {
        setVideos(json.videos ?? []);
        setR2Base(json.r2PublicUrl ?? "");
        setState("ok");
      })
      .catch(() => setState("error"));
  }, [screen]);

  // Focus search when list loads
  useEffect(() => {
    if (state === "ok" && !playing) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [state, playing]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (playing) { setPlaying(null); return; }
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, playing]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return videos;
    return videos.filter(
      (v) =>
        v.title.toLowerCase().includes(q) ||
        (v.description ?? "").toLowerCase().includes(q)
    );
  }, [videos, query]);

  return (
    <Portal>
      <Flex
        position="fixed" inset="0" zIndex="1500"
        align="center" justify="center" p="6"
        bg="blackAlpha.600"
        onClick={() => { if (!playing) onClose(); }}
      >
        <Box
          w="full" maxW="680px"
          bg="white" borderRadius="2xl"
          boxShadow="2xl"
          overflow="hidden"
          display="flex" flexDirection="column"
          maxH="85vh"
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Header ── */}
          <Flex
            px="5" py="4" align="center" justify="space-between" flexShrink={0}
            borderBottomWidth="1px" borderColor="gray.100"
          >
            <Flex align="center" gap="2">
              {playing ? (
                <Box
                  as="button"
                  onClick={() => setPlaying(null)}
                  p="1" borderRadius="md" color="gray.400"
                  _hover={{ bg: "gray.100", color: "gray.600" }}
                  mr="1"
                >
                  <ArrowLeft size={16} />
                </Box>
              ) : (
                <CircleHelp size={18} color="#6366f1" />
              )}
              <Text fontWeight="semibold" fontSize="sm" color="gray.800">
                {playing ? playing.title : "Videos de ayuda"}
              </Text>
            </Flex>
            <Box
              as="button"
              onClick={onClose}
              p="1" borderRadius="md" color="gray.400"
              _hover={{ bg: "gray.100", color: "gray.600" }}
            >
              <X size={16} />
            </Box>
          </Flex>

          {/* ── Player (cuando hay video seleccionado) ── */}
          {playing && (
            <Box flexShrink={0} bg="gray.900">
              <video
                key={playing.id}
                src={r2Url(r2Base, playing.video_key)}
                controls
                autoPlay
                style={{ width: "100%", display: "block", maxHeight: "360px" }}
              />
            </Box>
          )}

          {/* ── Buscador ── */}
          {!playing && state === "ok" && videos.length > 0 && (
            <Box px="4" pt="3" pb="2" flexShrink={0}>
              <Box position="relative">
                <Search
                  size={14}
                  color="#9ca3af"
                  style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
                />
                <Input
                  ref={searchRef}
                  pl="8" pr="3"
                  size="sm"
                  placeholder="Buscar por titulo o descripcion..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  borderRadius="lg"
                  bg="gray.50"
                  borderColor="gray.200"
                  _focus={{ borderColor: "purple.400", boxShadow: "0 0 0 2px rgba(167,139,250,0.2)" }}
                />
              </Box>
            </Box>
          )}

          {/* ── Lista de videos ── */}
          <Box flex="1" minH="0" overflowY="auto">
            {state === "loading" && (
              <Flex justify="center" align="center" py="16">
                <Spinner size="md" color="purple.500" />
              </Flex>
            )}

            {state === "error" && (
              <Flex direction="column" align="center" py="16" gap="2">
                <Text fontSize="sm" color="gray.400">No se pudo cargar la ayuda.</Text>
                <Text fontSize="xs" color="gray.300">Verifica tu conexion a internet.</Text>
              </Flex>
            )}

            {state === "ok" && videos.length === 0 && (
              <Flex direction="column" align="center" py="16" gap="2">
                <Text fontSize="sm" color="gray.400">Aun no hay videos para esta pantalla.</Text>
              </Flex>
            )}

            {state === "ok" && videos.length > 0 && !playing && filtered.length === 0 && (
              <Flex direction="column" align="center" py="10" gap="2">
                <Text fontSize="sm" color="gray.400">Sin resultados para "{query}".</Text>
              </Flex>
            )}

            {state === "ok" && (playing ? [playing] : filtered).map((video, idx, arr) => {
              const thumbUrl = video.thumbnail_key && r2Base ? r2Url(r2Base, video.thumbnail_key) : null;
              const isActive = playing?.id === video.id;

              return (
                <Flex
                  key={video.id}
                  as="button"
                  align="center" gap="4"
                  px="4" py="3"
                  borderBottomWidth={idx < arr.length - 1 ? "1px" : "0"}
                  borderColor="gray.100"
                  textAlign="left" w="full"
                  bg={isActive ? "purple.50" : "transparent"}
                  _hover={{ bg: "purple.50" }}
                  onClick={() => setPlaying(isActive ? null : video)}
                >
                  {/* Thumbnail */}
                  <Box
                    flexShrink={0}
                    w="88px" h="50px"
                    borderRadius="lg" overflow="hidden"
                    bg="gray.900"
                    position="relative"
                  >
                    {thumbUrl && (
                      <img
                        src={thumbUrl}
                        alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    )}
                    <Flex
                      position="absolute" inset="0"
                      align="center" justify="center"
                      bg={isActive ? "blackAlpha.600" : "blackAlpha.400"}
                    >
                      <Play size={16} color="white" fill="white" />
                    </Flex>
                  </Box>

                  {/* Info */}
                  <Box flex="1" minW="0">
                    <Text fontSize="sm" fontWeight="medium" color={isActive ? "purple.700" : "gray.800"} lineClamp={2}>
                      {video.title}
                    </Text>
                    {video.description && (
                      <Text fontSize="xs" color="gray.400" mt="0.5" lineClamp={2}>
                        {video.description}
                      </Text>
                    )}
                  </Box>
                </Flex>
              );
            })}
          </Box>
        </Box>
      </Flex>
    </Portal>
  );
}

export function HelpButton({ screen }: { screen: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tip text="Videos de ayuda">
        <Box
          as="button"
          aria-label="Ayuda"
          onClick={() => setOpen(true)}
          w="7" h="7"
          borderRadius="full"
          borderWidth="1.5px"
          borderColor="purple.200"
          color="purple.400"
          display="flex"
          alignItems="center"
          justifyContent="center"
          _hover={{ bg: "purple.50", borderColor: "purple.400", color: "purple.600" }}
          transition="all 0.15s"
        >
          <CircleHelp size={15} />
        </Box>
      </Tip>

      {open && <HelpModal screen={screen} onClose={() => setOpen(false)} />}
    </>
  );
}
