import { useMemo } from "react";
import type { Branch } from "../../ipc/git";
import { Combobox, type ComboboxGroup } from "../Combobox/Combobox";

interface BranchComboboxProps {
  ariaLabel: string;
  className?: string;
  value: string | null;
  branches: Branch[];
  onChange: (ref: string) => void;
}

/** The shared combobox, grouped the way refs read: local first, then remote. */
export function BranchCombobox({
  ariaLabel,
  className,
  value,
  branches,
  onChange,
}: BranchComboboxProps) {
  const groups = useMemo<ComboboxGroup[]>(() => {
    const named = (isRemote: boolean) =>
      branches.filter((branch) => branch.isRemote === isRemote).map((branch) => branch.name);

    const result: ComboboxGroup[] = [];
    // A tag or SHA typed by hand is not in the branch list, so give it a home —
    // otherwise the current selection would vanish from the list entirely.
    if (value && !branches.some((branch) => branch.name === value)) {
      result.push({ label: "Current ref", items: [value] });
    }
    const local = named(false);
    if (local.length > 0) result.push({ label: "Local", items: local });
    const remote = named(true);
    if (remote.length > 0) result.push({ label: "Remote", items: remote });
    return result;
  }, [branches, value]);

  return (
    <Combobox
      ariaLabel={ariaLabel}
      className={className}
      value={value}
      groups={groups}
      onChange={onChange}
      placeholder="branch, tag, or SHA"
    />
  );
}
