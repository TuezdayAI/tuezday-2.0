// apps/web/src/components/ui/icon.tsx
// The ONE icon vocabulary (spec §4). No page imports lucide-react directly.
import type { SVGProps } from "react";
import {
  House, Brain, Megaphone, Radar, PenTool, CircleCheckBig, Users, Settings,
  Mail, Image, FileText, Target, Layers,
  CircleAlert, Radio, Sparkles, Check, X, TrendingUp,
  Flame, Crosshair, Mic, BookOpen, Zap,
  Pencil, RefreshCw, Plug, Settings2,
  BadgeCheck, ListChecks, WalletCards, SlidersHorizontal, Send, Unplug, ShieldAlert,
  Calendar, Search, Plus, ChevronLeft, ChevronRight, ChevronDown, ExternalLink, User, Bell, TriangleAlert, Info,
  type LucideIcon,
} from "lucide-react";
import { BRAND_ICONS, type BrandName } from "./brand-icons";

// Note: lucide-react 1.x renamed AlertCircle -> CircleAlert and
// CheckCircle2 -> CircleCheckBig (shape-first naming). Registry keys below are
// unchanged from the spec vocabulary.
export const ICON_REGISTRY = {
  // nav groups (tone-colored in context)
  home: House, brain: Brain, campaigns: Megaphone, discover: Radar,
  create: PenTool, review: CircleCheckBig, audience: Users, settings: Settings,
  // content types
  email: Mail, post: Image, blog: FileText, ad: Target, carousel: Layers,
  // resolver output (FlowStrip bundle node)
  bundle: Layers,
  // status (pairs with Badge)
  "status-review": CircleAlert, "status-live": Radio, "status-generating": Sparkles,
  "status-approved": Check, "status-rejected": X, "status-learning": TrendingUp,
  // brain docs
  "doc-soul": Flame, "doc-icp": Crosshair, "doc-voice": Mic,
  "doc-history": BookOpen, "doc-now": Zap,
  // actions
  approve: Check, reject: X, edit: Pencil, regenerate: RefreshCw,
  connect: Plug, "module-settings": Settings2,
  authorize: BadgeCheck, batch: ListChecks, budget: WalletCards,
  targeting: SlidersHorizontal, send: Send, signal: Radar,
  "connection-lost": Unplug, "campaign-risk": ShieldAlert,
  // common UI
  calendar: Calendar, search: Search, add: Plus, close: X,
  "chevron-left": ChevronLeft, "chevron-right": ChevronRight, "chevron-down": ChevronDown,
  external: ExternalLink, user: User, notification: Bell,
  warning: TriangleAlert, info: Info,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICON_REGISTRY;
export const ICON_NAMES = Object.keys(ICON_REGISTRY) as IconName[];

const SEMANTIC_SIZE = {
  compact: "16px",
  standard: "18px",
  emphasized: "20px",
} as const;
type SemanticIconSize = keyof typeof SEMANTIC_SIZE;
type LegacyIconSize = "sm" | "md" | "lg";
export type IconSize = SemanticIconSize | LegacyIconSize;

const LEGACY_ICON_SIZE: Record<LegacyIconSize, SemanticIconSize> = {
  sm: "compact",
  md: "standard",
  lg: "emphasized",
};

function iconPixels(size: IconSize): (typeof SEMANTIC_SIZE)[SemanticIconSize] {
  const semantic = size === "sm" || size === "md" || size === "lg"
    ? LEGACY_ICON_SIZE[size]
    : size;
  return SEMANTIC_SIZE[semantic];
}

interface IconProps {
  name: IconName;
  size?: IconSize;
  /** Extra class for tone contexts; color flows via currentColor. */
  className?: string;
  "aria-label"?: string;
}

export function Icon({ name, size = "standard", className, ...rest }: IconProps) {
  const Cmp = ICON_REGISTRY[name];
  return (
    <Cmp
      className={className}
      strokeWidth={1.8}
      style={{ width: iconPixels(size), height: iconPixels(size), flexShrink: 0 }}
      aria-hidden={rest["aria-label"] ? undefined : true}
      {...rest}
    />
  );
}

interface BrandIconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: BrandName;
  size?: IconSize;
  /** Ink-colored at rest; true only on connect surfaces (spec §4). */
  brandColor?: boolean;
}

const BRAND_HEX: Record<BrandName, string> = {
  linkedin: "#0A66C2", x: "#000000", reddit: "#FF4500", instagram: "#E4405F",
  meta: "#0081FB", google: "#4285F4", freshsales: "#FA692F",
};

export function BrandIcon({ name, size = "standard", brandColor = false, style, ...rest }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      style={{ width: iconPixels(size), height: iconPixels(size), flexShrink: 0, ...style }}
      fill={brandColor ? BRAND_HEX[name] : "currentColor"}
      aria-hidden={rest["aria-label"] ? undefined : true}
      {...rest}
    >
      <path d={BRAND_ICONS[name]} />
    </svg>
  );
}
