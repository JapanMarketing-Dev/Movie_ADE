/**
 * Tabs above the center pane (the look of Ferret's CenterTabs; Orca由来: ~/bench/orca/src/renderer/src/components/tab-bar/、
 * MIT、Ferret 経由). Used where one mode has two screens (投稿: 投稿 / サムネイル).
 */
export function PaneTabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { id: T; label: string }[]; onChange: (id: T) => void }) {
  return (
    <div className="pane-tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" aria-selected={tab.id === value} className="pane-tab" onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}
