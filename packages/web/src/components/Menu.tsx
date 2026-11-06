import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactElement } from "react";
import { classNames } from "../design/classNames.ts";

interface MenuItemSpec {
  readonly label: string;
  readonly onSelect: () => void;
  readonly shortcut?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

export interface MenuProps {
  readonly trigger: ReactElement;
  readonly label: string;
  readonly items: readonly MenuItemSpec[];
}

/** A menu on Base UI: arrow-key navigation, Esc, and typeahead are the library's (0101). */
export function Menu({ trigger, label, items }: MenuProps): ReactElement {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={4} className="hns-menu-positioner">
          <BaseMenu.Popup className="hns-menu-popup" aria-label={label}>
            {items.map((item) => (
              <BaseMenu.Item
                key={item.label}
                className={classNames("hns-menu-item", item.danger && "hns-menu-item--danger")}
                disabled={item.disabled}
                onClick={item.onSelect}
              >
                <span>{item.label}</span>
                {item.shortcut === undefined ? null : (
                  <kbd className="hns-menu-shortcut">{item.shortcut}</kbd>
                )}
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
