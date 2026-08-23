import type {
  CSSProperties,
  ChangeEvent,
  FormEvent,
  ReactNode,
} from "react";

export declare const GOODOS_TOPBAR_WIDGET_VERSION = "3.0.0";
export declare const GOODOS_LOGIN_WIDGET_VERSION = "1.5.0";
export declare const GOODOS_LOGIN_SHELL_VERSION = "1.2.0";
export declare const GOODOS_AUTH_ORIGIN = "https://base.goodos.app";

export interface GoodOSIdentityProviderRecord {
  id: string;
  provider_type: string;
  display_name?: string;
  available: boolean;
}

export declare function loadGoodOSIdentityProviders(
  origin?: string,
): Promise<GoodOSIdentityProviderRecord[]>;

export declare function goodOSIdentityProviderUrl(
  providerId: string,
  redirect: string,
  origin?: string,
): string;

export declare function goodOSAccountUrl(
  mode: "login" | "register" | "forgot",
  redirect: string,
  origin?: string,
): string;

interface SharedProps {
  className?: string;
  style?: CSSProperties;
}

export interface GoodOSTopBarChildrenProps extends SharedProps {
  children: ReactNode;
  appName?: never;
  workspaceLabel?: never;
  brandIcon?: never;
  leadingControl?: never;
  search?: never;
  actions?: never;
  controls?: never;
  onBrandClick?: never;
  brandClassName?: never;
  brandMarkClassName?: never;
  workspaceClassName?: never;
  searchClassName?: never;
}

export interface GoodOSTopBarStructuredProps extends SharedProps {
  children?: never;
  appName: string;
  workspaceLabel: string;
  brandIcon: ReactNode;
  leadingControl?: ReactNode;
  search: ReactNode;
  actions?: ReactNode;
  controls: ReactNode;
  onBrandClick?: () => void;
  brandClassName?: string;
  brandMarkClassName?: string;
  workspaceClassName?: string;
  searchClassName?: string;
}

export declare function GoodOSTopBarWidget(
  props: GoodOSTopBarChildrenProps | GoodOSTopBarStructuredProps,
): ReactNode;

export type GoodOSIdentityProvider = "google" | "apple" | "microsoft";

export interface GoodOSLoginWidgetProps extends SharedProps {
  appName: string;
  subtitle: string;
  accent?: string;
  accentInk?: string;
  email: string;
  password: string;
  onEmailChange?: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  onPasswordChange?: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onProviderSignIn?: (provider: GoodOSIdentityProvider) => void;
  onGoodOSSignIn?: () => void;
  passkeyAvailable?: boolean;
  passkeyLoading?: boolean;
  onPasskeySignIn?: () => void;
  providerAvailability?: Partial<Record<GoodOSIdentityProvider, boolean>>;
  onForgotPassword?: () => void;
  onCreateAccount?: () => void;
  loading?: boolean;
  error?: string;
  homeHref?: string;
  initialMode?: "dark" | "light";
  mobileBrand?: ReactNode;
  emailPlaceholder?: string;
  passwordPlaceholder?: string;
  securityTitle?: string;
  securityDescription?: string;
  termsHref?: string;
  privacyHref?: string;
}

export declare function GoodOSLoginWidget(
  props: GoodOSLoginWidgetProps,
): ReactNode;

export interface GoodOSLoginShellProps extends SharedProps {
  brandPanel: ReactNode;
  children: ReactNode;
  brandClassName?: string;
  authClassName?: string;
}

export declare function GoodOSLoginShell(
  props: GoodOSLoginShellProps,
): ReactNode;
