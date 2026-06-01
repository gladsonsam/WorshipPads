// Shared stereo/mono channel-pair picker. Used by all three buses (pad/click/cue)
// in Settings — extracted so adding another bus is one entry, not a copy/paste.

import { Eyebrow, Segmented, SelectField } from "./ui";

export function RoutingPicker({
  channelCount,
  channelLeft,
  channelRight,
  onChange,
}: {
  channelCount: number;
  channelLeft: number;
  channelRight: number;
  onChange: (left: number, right: number) => void;
}) {
  const isMono = channelLeft === channelRight;
  const opts = Array.from({ length: Math.max(1, channelCount) }, (_, i) => ({
    value: String(i),
    label: String(i + 1),
  }));

  function toMode(mode: "stereo" | "mono") {
    if (mode === "mono") {
      onChange(channelLeft, channelLeft);
    } else {
      // Pick a sensible R that differs from L. Prefer L+1; fall back to L-1
      // when L is already on the last channel of the device.
      let r = channelLeft + 1;
      if (r >= channelCount) r = Math.max(0, channelLeft - 1);
      if (r === channelLeft) r = channelLeft; // 1-channel device: no real stereo
      onChange(channelLeft, r);
    }
  }

  return (
    <div>
      <div className="routing-head">
        <Eyebrow style={{ letterSpacing: "0.08em" }}>Mode</Eyebrow>
        <Segmented<"stereo" | "mono">
          value={isMono ? "mono" : "stereo"}
          onChange={toMode}
          options={[
            { key: "stereo", label: "Stereo" },
            { key: "mono", label: "Mono" },
          ]}
        />
      </div>

      {isMono ? (
        <SelectField
          label="Channel"
          mono
          style={{ marginTop: 10 }}
          value={String(channelLeft)}
          options={opts}
          onChange={(v) => onChange(Number(v), Number(v))}
        />
      ) : (
        <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
          <SelectField
            label="Left → ch"
            mono
            style={{ width: "50%" }}
            value={String(channelLeft)}
            options={opts}
            onChange={(v) => onChange(Number(v), channelRight)}
          />
          <SelectField
            label="Right → ch"
            mono
            style={{ width: "50%" }}
            value={String(channelRight)}
            options={opts}
            onChange={(v) => onChange(channelLeft, Number(v))}
          />
        </div>
      )}
    </div>
  );
}
