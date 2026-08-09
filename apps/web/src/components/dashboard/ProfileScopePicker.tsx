import { Layers3 } from 'lucide-react';

import type { DashboardState } from '../../../../../packages/shared/src';
import { AssetLabel } from '../../app/dashboardHelpers';

type Props = {
  profiles: DashboardState['profiles'];
  selectedProfileId: string;
  onSelectProfile: (profileId: string) => void;
};

export function ProfileScopePicker({ profiles, selectedProfileId, onSelectProfile }: Props) {
  const activeProfiles = profiles.filter((item) => item.profile.status !== 'disabled');

  if (activeProfiles.length <= 1) return null;

  return (
    <section className="scopePicker" aria-label="Data scope">
      <div className="scopePickerLabel">
        <Layers3 size={15} aria-hidden="true" />
        <span>Scope</span>
      </div>
      <div className="scopePickerOptions">
        <button
          type="button"
          className={`scopePickerButton ${selectedProfileId === 'all' ? 'active' : ''}`}
          aria-pressed={selectedProfileId === 'all'}
          onClick={() => onSelectProfile('all')}
        >
          All profiles
          <span>{activeProfiles.length}</span>
        </button>
        {activeProfiles.map((item) => (
          <button
            key={item.profile.id}
            type="button"
            className={`scopePickerButton ${selectedProfileId === item.profile.id ? 'active' : ''}`}
            aria-pressed={selectedProfileId === item.profile.id}
            onClick={() => onSelectProfile(item.profile.id)}
          >
            <AssetLabel profileId={item.profile.id} label={item.profile.label} size="sm" />
          </button>
        ))}
      </div>
    </section>
  );
}
