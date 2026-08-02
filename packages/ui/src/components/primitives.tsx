import { Button as BaseButton, Dialog, Tabs, Tooltip } from "@base-ui-components/react";
import type { ComponentProps, ReactNode } from "react";

import { buttonVariants, type VariantProps } from "../variants";

type ButtonVariantProps = VariantProps<typeof buttonVariants>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ButtonProps = DistributiveOmit<ComponentProps<typeof BaseButton>, "className"> &
  ButtonVariantProps & { readonly className?: string };

export const Button = ({ className, tone, size, ...props }: ButtonProps) => (
  <BaseButton className={buttonVariants({ tone, size, class: className })} {...props} />
);

export interface ModalProps {
  readonly trigger: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}

export const Modal = ({ trigger, title, description, children }: ModalProps) => (
  <Dialog.Root>
    <Dialog.Trigger render={<span className="inline-flex" />}>{trigger}</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 bg-ink/50" />
      <Dialog.Viewport className="fixed inset-0 grid place-items-center p-4">
        <Dialog.Popup className="stavka-panel w-full max-w-xl p-6 text-ink">
          <Dialog.Title className="font-display text-2xl uppercase">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description className="mt-2 text-sm">{description}</Dialog.Description>
          ) : null}
          <div className="mt-5">{children}</div>
          <Dialog.Close render={<Button className="mt-5" />}>Close</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>
);

export const Hint = ({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}) => (
  <Tooltip.Provider>
    <Tooltip.Root>
      <Tooltip.Trigger render={<span className="inline-flex" />}>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="border border-ink bg-ink px-2 py-1 font-data text-xs text-paper">
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>
);

export interface SegmentTab {
  readonly value: string;
  readonly label: ReactNode;
  readonly panel: ReactNode;
}

export const SegmentTabs = ({
  tabs,
  defaultValue,
}: {
  readonly tabs: readonly SegmentTab[];
  readonly defaultValue: string;
}) => (
  <Tabs.Root defaultValue={defaultValue}>
    <Tabs.List className="flex border-b border-contour">
      {tabs.map((tab) => (
        <Tabs.Tab
          key={tab.value}
          value={tab.value}
          className="px-3 py-2 font-data text-xs uppercase data-active:bg-ink data-active:text-paper"
        >
          {tab.label}
        </Tabs.Tab>
      ))}
    </Tabs.List>
    {tabs.map((tab) => (
      <Tabs.Panel key={tab.value} value={tab.value} className="py-3">
        {tab.panel}
      </Tabs.Panel>
    ))}
  </Tabs.Root>
);
