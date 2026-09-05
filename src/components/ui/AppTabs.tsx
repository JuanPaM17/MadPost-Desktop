import { Tabs } from "@chakra-ui/react";
import type { ReactNode } from "react";

export type AppTab = { value: string; label: string; content: ReactNode };

export function AppTabs({ tabs, defaultValue, onValueChange }: { tabs: AppTab[]; defaultValue: string; onValueChange?: (value: string) => void }) {
  return <Tabs.Root defaultValue={defaultValue} variant="line" fitted={false} onValueChange={(details) => onValueChange?.(details.value)}><Tabs.List className="tabs-scroll" overflowX="auto" mb="7">{tabs.map((tab) => <Tabs.Trigger key={tab.value} value={tab.value}>{tab.label}</Tabs.Trigger>)}</Tabs.List>{tabs.map((tab) => <Tabs.Content key={tab.value} value={tab.value}>{tab.content}</Tabs.Content>)}</Tabs.Root>;
}
