'use client';

import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * Compact profile selector for the sidebar header. Profile configures the
 * runtime, so this is a runtime-context switch, not a per-session option.
 *
 * The launch/default profile maps to the runtime's empty profile (''); named
 * profiles map to their name. The catalog is truthful (Hermes `profiles.list`);
 * with a single profile it renders one selected option and is ready for more.
 *
 * @param {{
 *   profiles: Array<{ name: string, displayName: string, isDefault: boolean }>,
 *   activeProfile: string,
 *   onSelect: (profile: string) => void,
 *   disabled?: boolean,
 *   className?: string,
 * }} props
 */
export default function ProfilePicker({
  profiles,
  activeProfile,
  onSelect,
  disabled,
  className,
}) {
  const optionValue = (profile) => (profile.isDefault ? '' : profile.name);
  const rows = profiles.length
    ? profiles
    : [{ name: 'default', displayName: 'default', isDefault: true }];

  return (
    <Select
      wrapperClassName={cn('min-w-0 flex-1', className)}
      className="h-9"
      aria-label="Hermes profile"
      value={activeProfile}
      disabled={disabled}
      onChange={(event) => onSelect?.(event.target.value)}
    >
      {rows.map((profile) => {
        const value = optionValue(profile);
        const label = profile.displayName || profile.name || 'default';
        return (
          <option key={profile.name || 'default'} value={value}>
            {profile.isDefault ? `${label} (default)` : label}
          </option>
        );
      })}
    </Select>
  );
}
