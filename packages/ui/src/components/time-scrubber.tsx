import { Slider } from "@base-ui-components/react";

import { Button } from "./primitives";

const speeds = [1, 10, 100] as const;

export interface TimeScrubberProps {
  readonly paused: boolean;
  readonly speed: number;
  readonly time: number;
  readonly maxTime: number;
  readonly onPausedChange: (paused: boolean) => void;
  readonly onStep: () => void;
  readonly onSpeedChange: (speed: number) => void;
  readonly onSeek?: (time: number) => void;
}

export const TimeScrubber = ({
  paused,
  speed,
  time,
  maxTime,
  onPausedChange,
  onStep,
  onSpeedChange,
  onSeek,
}: TimeScrubberProps) => (
  <div className="stavka-panel space-y-3 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <Button
        tone={paused ? "primary" : "neutral"}
        onClick={() => onPausedChange(!paused)}
        aria-pressed={paused}
      >
        {paused ? "Resume" : "Pause"}
      </Button>
      <Button onClick={onStep} disabled={!paused}>
        Step
      </Button>
      {speeds.map((item) => (
        <Button
          key={item}
          size="sm"
          tone={speed === item ? "primary" : "neutral"}
          onClick={() => onSpeedChange(item)}
          aria-pressed={speed === item}
        >
          ×{item}
        </Button>
      ))}
      <output className="ml-auto font-data text-xs">T+{time.toFixed(1)}s</output>
    </div>
    <Slider.Root
      value={time}
      min={0}
      max={Math.max(1, maxTime)}
      step={0.1}
      disabled={!onSeek}
      onValueChange={(value) => onSeek?.(value)}
    >
      <Slider.Control className="flex h-5 touch-none items-center">
        <Slider.Track className="relative h-1 w-full bg-contour">
          <Slider.Indicator className="absolute h-full bg-carmine" />
          <Slider.Thumb className="size-4 border border-ink bg-paper" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  </div>
);
