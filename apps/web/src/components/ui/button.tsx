// apps/web/src/components/ui/button.tsx
import Link from "next/link";
import type {
  ButtonHTMLAttributes,
  ComponentPropsWithoutRef,
  MouseEvent,
  ReactNode,
} from "react";
import { Icon } from "./icon";
import styles from "./button.module.css";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "danger";
export type ButtonSize = "compact" | "standard" | "large";

type LegacyButtonVariant = "ghost";
type LegacyButtonSize = "sm" | "md";
type ButtonVariantInput = ButtonVariant | LegacyButtonVariant;
type ButtonSizeInput = ButtonSize | LegacyButtonSize;

const LEGACY_VARIANTS: Record<LegacyButtonVariant, ButtonVariant> = {
  ghost: "tertiary",
};

const LEGACY_SIZES: Record<LegacyButtonSize, ButtonSize> = {
  sm: "compact",
  md: "standard",
};

function normalizeVariant(variant: ButtonVariantInput): ButtonVariant {
  return variant === "ghost" ? LEGACY_VARIANTS[variant] : variant;
}

function normalizeSize(size: ButtonSizeInput): ButtonSize {
  return size === "sm" || size === "md" ? LEGACY_SIZES[size] : size;
}

function buttonClasses(
  variant: ButtonVariantInput,
  size: ButtonSizeInput,
  className?: string,
): string {
  return [
    styles.button,
    styles[normalizeVariant(variant)],
    styles[normalizeSize(size)],
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

interface ActionContentProps {
  children: ReactNode;
  leadingIcon?: ReactNode;
  loading?: boolean;
}

function ActionContent({ children, leadingIcon, loading = false }: ActionContentProps) {
  return (
    <>
      <span className={styles.content}>
        {leadingIcon}
        <span>{children}</span>
      </span>
      {loading && (
        <span className={styles.loadingIndicator} aria-hidden="true">
          <Icon name="status-generating" size="sm" />
        </span>
      )}
    </>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariantInput;
  size?: ButtonSizeInput;
  loading?: boolean;
  leadingIcon?: ReactNode;
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "standard",
  className,
  children,
  loading = false,
  leadingIcon,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={buttonClasses(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      {...rest}
    >
      <ActionContent leadingIcon={leadingIcon} loading={loading}>
        {children}
      </ActionContent>
    </button>
  );
}

type NextLinkProps = ComponentPropsWithoutRef<typeof Link>;

interface ButtonLinkProps extends Omit<NextLinkProps, "className" | "children"> {
  variant?: ButtonVariantInput;
  size?: ButtonSizeInput;
  loading?: boolean;
  leadingIcon?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function ButtonLink({
  variant = "secondary",
  size = "standard",
  loading = false,
  leadingIcon,
  className,
  children,
  onClick,
  "aria-disabled": ariaDisabled,
  ...rest
}: ButtonLinkProps) {
  const unavailable = loading || ariaDisabled === true || ariaDisabled === "true";
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (unavailable) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  return (
    <Link
      className={buttonClasses(variant, size, className)}
      aria-busy={loading || undefined}
      aria-disabled={unavailable || undefined}
      data-loading={loading || undefined}
      onClick={handleClick}
      {...rest}
    >
      <ActionContent leadingIcon={leadingIcon} loading={loading}>
        {children}
      </ActionContent>
    </Link>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "compact" | "standard";
  children: ReactNode;
}

export function IconButton({
  label,
  size = "standard",
  title,
  className,
  children,
  ...rest
}: IconButtonProps) {
  const classes = [
    styles.iconButton,
    size === "compact" ? styles.iconCompact : styles.iconStandard,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} aria-label={label} title={title ?? label} {...rest}>
      {children}
    </button>
  );
}
