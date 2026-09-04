import { createToaster, Toaster, Toast } from "@chakra-ui/react";

export const toaster = createToaster({ placement: "bottom-end", pauseOnPageIdle: true });

export function AppToaster() {
  return <Toaster toaster={toaster}>{(toast) => <Toast.Root width={{ md: "sm" }}><Toast.Indicator /><Toast.Title>{toast.title}</Toast.Title>{toast.description ? <Toast.Description>{toast.description}</Toast.Description> : null}<Toast.CloseTrigger /></Toast.Root>}</Toaster>;
}

export const notify = {
  success: (title: string, description?: string) => toaster.create({ type: "success", title, description }),
  error: (title: string, description?: string) => toaster.create({ type: "error", title, description }),
};
