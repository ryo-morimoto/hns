import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactElement } from "react";
import { classNames } from "../design/classNames.ts";
import { Icon } from "./Icon.tsx";

interface MenuItemSpec {
  readonly label: string;
  readonly onSelect: () => void;
  readonly shortcut?: string | undefined;
  readonly danger?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  /** Selection menus expose radio semantics; plain action menus leave this undefined. */
  readonly selected?: boolean | undefined;
}

export interface MenuProps {
  readonly trigger: ReactElement;
  readonly label: string;
  readonly items: readonly MenuItemSpec[];
}

/** A menu on Base UI: arrow-key navigation, Esc, and typeahead are the library's. */
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
                role={item.selected === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.selected}
                disabled={item.disabled}
                onClick={item.onSelect}
              >
                <span className="hns-menu-item__label">
                  <span className="hns-menu-item__check-slot" aria-hidden="true">
                    {item.selected === true ? (
                      <Icon name="check" size={12} className="hns-menu-item__check" />
                    ) : null}
                  </span>
                  <span className="hns-menu-item__text">{item.label}</span>
                </span>
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
