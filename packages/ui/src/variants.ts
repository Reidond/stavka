import { tv } from "tailwind-variants";

export { cn, cx, tv, type VariantProps } from "tailwind-variants";

export const buttonVariants = tv({
  base: `border font-data tracking-wider uppercase disabled:cursor-not-allowed disabled:opacity-50`,
  variants: {
    tone: {
      neutral: `border-ink bg-paper text-ink hover:bg-contour`,
      primary: `border-ink bg-ink text-paper hover:bg-ultramarine`,
      danger: `border-carmine bg-carmine text-paper hover:bg-ink`,
    },
    size: {
      sm: "px-2 py-1 text-[0.65rem]",
      md: "px-3 py-2 text-xs",
    },
  },
  defaultVariants: { tone: "neutral", size: "md" },
});

export const statusVariants = tv({
  variants: {
    tone: {
      works: "border-olive text-olive",
      broken: "border-carmine text-carmine",
      pending: "border-ultramarine text-ultramarine",
      neutral: "border-ink text-ink",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export const orderVariants = tv({
  base: "border-l-4 p-4",
  variants: {
    priority: {
      normal: "border-ultramarine bg-ultramarine/5",
      urgent: "border-carmine bg-carmine/5",
    },
  },
  defaultVariants: { priority: "normal" },
});

export const legendSwatchVariants = tv({
  base: "size-2.5 border border-ink",
  variants: {
    tone: {
      friendly: "bg-ultramarine",
      enemy: "bg-carmine",
      terrain: "bg-olive",
      objective: "bg-contour",
    },
  },
});
