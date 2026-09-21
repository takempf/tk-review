import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { useId, useState } from "react";
import css from "./Combobox.module.css";

/** Base UI reads `items` from each group; the other keys are ours. */
export interface ComboboxGroup {
  label: string;
  items: string[];
}

interface ComboboxProps {
  /** Rendered beside the field; omit it (and pass `ariaLabel`) where space is tight. */
  label?: string;
  ariaLabel?: string;
  value: string | null;
  groups: ComboboxGroup[];
  onChange: (value: string) => void;
  placeholder: string;
  /** Extra class on the root, for layout in the parent (e.g. flexing to fill a row). */
  className?: string;
  /**
   * Commit `""` the moment the input is emptied. For fields where empty is a
   * meaningful value ("use the default") rather than an incomplete one.
   */
  commitEmpty?: boolean;
  /**
   * Commit whatever is typed as it is typed, like a plain input with
   * suggestions. For preference fields, where "shown but not applied" would
   * mislead. Leave off for fields whose commit triggers real work (branches
   * reload the whole diff). Implies `commitEmpty`.
   */
  commitTyped?: boolean;
  /**
   * Called when the suggestion popup opens or closes. For fields whose options
   * cost something to produce — a network call, say — so the cost is paid when
   * someone actually looks rather than on every render of the header.
   */
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

/**
 * The app's one combobox: a text field with grouped suggestions, where any
 * typed value is also acceptable. Branch selection and the review model picker
 * share it, so they share a look — triangle included.
 */
export function Combobox({
  label,
  ariaLabel,
  value,
  groups,
  onChange,
  placeholder,
  className,
  commitEmpty = false,
  commitTyped = false,
  onOpenChange,
  disabled = false,
}: ComboboxProps) {
  const [query, setQuery] = useState("");
  // `Combobox.Label` labels the trigger, not the input, so the association has to
  // be made explicitly against the input that actually holds the value.
  const inputId = useId();

  const typed = query.trim();

  return (
    <BaseCombobox.Root
      items={groups}
      disabled={disabled}
      value={value}
      onOpenChange={onOpenChange}
      onValueChange={(next) => {
        if (typeof next === "string" && next !== value) onChange(next);
      }}
      onInputValueChange={(next) => {
        setQuery(next);
        const typed = next.trim();
        if (commitTyped) {
          if (typed !== (value ?? "")) onChange(typed);
        } else if (commitEmpty && typed === "" && value) {
          // Deleting the text is how the field goes back to "default".
          onChange("");
        }
      }}
    >
      <div className={className ? `${css.field} ${className}` : css.field}>
        {label ? (
          <label className={css.label} htmlFor={inputId}>
            {label}
          </label>
        ) : null}
        <BaseCombobox.InputGroup className={css.inputGroup}>
          <BaseCombobox.Input
            id={inputId}
            className={css.input}
            placeholder={placeholder}
            aria-label={label ? undefined : ariaLabel}
          />
          <BaseCombobox.Trigger
            className={css.trigger}
            aria-label={`Show ${label ?? ariaLabel ?? "options"}`}
          >
            <BaseCombobox.Icon className={css.icon}>
              {/* Equilateral: the viewBox height is the side length × √3/2, so the
                  triangle stays equilateral at whatever width the CSS gives it. */}
              <svg className={css.chevron} viewBox="0 0 10 8.6603" aria-hidden="true">
                <polygon points="0,0 10,0 5,8.6603" />
              </svg>
            </BaseCombobox.Icon>
          </BaseCombobox.Trigger>
        </BaseCombobox.InputGroup>
      </div>

      <BaseCombobox.Portal>
        {/* Left-aligned rather than centred: the popup is usually wider than the
            field, and centring makes it spread out from under both edges. */}
        <BaseCombobox.Positioner className={css.positioner} sideOffset={4} align="start">
          <BaseCombobox.Popup className={css.popup}>
            {/* Any typed value is acceptable, so offer to use text that matches
                no suggestion rather than treating it as a dead end. */}
            <BaseCombobox.Empty className={css.empty}>
              {typed ? (
                <button type="button" className={css.useRaw} onClick={() => onChange(typed)}>
                  Use “{typed}”
                </button>
              ) : (
                "No options"
              )}
            </BaseCombobox.Empty>

            <BaseCombobox.List className={css.list}>
              <BaseCombobox.Collection>
                {(group: ComboboxGroup) => (
                  <BaseCombobox.Group key={group.label} items={group.items} className={css.group}>
                    <BaseCombobox.GroupLabel className={css.groupLabel}>
                      {group.label}
                    </BaseCombobox.GroupLabel>
                    <BaseCombobox.Collection>
                      {(item: string) => (
                        <BaseCombobox.Item key={item} value={item} className={css.item}>
                          <span className={css.itemText}>{item}</span>
                          <BaseCombobox.ItemIndicator className={css.indicator}>
                            ✓
                          </BaseCombobox.ItemIndicator>
                        </BaseCombobox.Item>
                      )}
                    </BaseCombobox.Collection>
                  </BaseCombobox.Group>
                )}
              </BaseCombobox.Collection>
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
