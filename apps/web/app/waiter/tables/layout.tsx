import { WaiterShellProvider } from "../../../lib/waiter-shell";

// Shared layout preserves prepared state during child-route navigation.
// Leaving this subtree drops it; logout/lock replace the document entirely.
export default function WaiterTablesLayout({ children }: { children: React.ReactNode }) {
  return <WaiterShellProvider>{children}</WaiterShellProvider>;
}
