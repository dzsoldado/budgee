// Line icons from the mockups (24×24 view box, stroke follows the text color).
import type { JSX } from "solid-js";

interface IconProps {
  size: number;
  strokeWidth?: number;
}

function Icon(props: IconProps & { children: JSX.Element; round?: boolean }) {
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? 2}
      stroke-linecap="round"
      stroke-linejoin={props.round === false ? undefined : "round"}
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export const ListIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={props.strokeWidth ?? 2.4} round={false}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const DashboardIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Icon>
);

export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
  </Icon>
);

export const TagIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={props.strokeWidth ?? 2.2}>
    <path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
    <circle cx="7.5" cy="7.5" r="1.5" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={props.strokeWidth ?? 2.4} round={false}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const ChevronLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M15 18l-6-6 6-6" />
  </Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 18l6-6-6-6" />
  </Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const CalendarIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M16 3v4M8 3v4M3 10h18" />
  </Icon>
);

export const ChevronUpIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M18 15l-6-6-6 6" />
  </Icon>
);

export const QrIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" />
  </Icon>
);

export const PhoneIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="6" y="2" width="12" height="20" rx="2" />
    <path d="M11 18h2" />
  </Icon>
);

export const DesktopIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </Icon>
);

export const CloudIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M17.5 19H7a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 11a4 4 0 0 1-1.5 8z" />
  </Icon>
);

export const KeyIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2L20 3M17 6l3 3M14 9l2 2" />
  </Icon>
);

export const UploadIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
  </Icon>
);

export const DownloadIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
  </Icon>
);

export const FileIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </Icon>
);

export const RefreshIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </Icon>
);

/** Three dots (filled), the mockups' chart menu. */
export const MoreIcon = (props: IconProps) => (
  <svg
    width={props.size}
    height={props.size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);

// Chart types (ChartEdit.dc.html).
export const BarsIcon = (props: IconProps) => (
  <Icon {...props} round={false}>
    <path d="M4 6h12M4 12h16M4 18h8" />
  </Icon>
);

export const LineChartIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 17l6-6 4 4 8-8" />
  </Icon>
);

export const DoughnutIcon = (props: IconProps) => (
  <Icon {...props} round={false}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 4v4.5" />
  </Icon>
);

export const TableIcon = (props: IconProps) => (
  <Icon {...props} round={false}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18M9 10v9" />
  </Icon>
);
