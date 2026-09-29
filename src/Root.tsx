import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Theme, Toaster, TooltipProvider } from "tk-design-system";
import { App } from "./App";
import { persistOptions, queryClient } from "./lib/queries";

/**
 * The app inside the query cache's and the design system's providers; shared
 * with the dev harness.
 */
export function Root() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <Theme scope="document" name="base">
        <TooltipProvider delay={400}>
          <Toaster>
            <App />
          </Toaster>
        </TooltipProvider>
      </Theme>
    </PersistQueryClientProvider>
  );
}
