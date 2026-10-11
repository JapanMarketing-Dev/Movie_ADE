/**
 * Shared UI primitives (ported from Ferret src/renderer/ui, MIT).
 *
 * Build screens from these first; add here when something is missing instead of one-off buttons per screen.
 *   - colors, sizes and durations only from styles/tokens.css
 *   - no gradients or glows; gray surfaces and 1px lines
 *   - the red accent marks selection, progress and counts; recording has its own red
 *   - lucide icons at 13–16px (stroke width is unified in ui.css)
 *   - animate transform / opacity only
 */
export { Badge, CountBadge, type BadgeTone } from './Badge';
export { Button, IconButton, type ButtonProps, type ButtonVariant } from './Button';
export { Note, Select, SettingRow, Switch, type SelectOption } from './Controls';
export { EmptyState, Kbd } from './EmptyState';
export { ErrorBoundary } from './ErrorBoundary';
export { IconTile } from './IconTile';
export { Card, ListRow } from './ListRow';
export { Modal } from './Modal';
export { Popover } from './Popover';
export { Progress, RecordDot, Skeleton, Spinner } from './Progress';
export { RecordButton } from './RecordButton';
export { Segmented, type SegmentedOption } from './Segmented';
export { TextField } from './TextField';
export { ToastProvider, useToast, type ToastOptions, type ToastTone } from './Toast';
export { Tooltip } from './Tooltip';
