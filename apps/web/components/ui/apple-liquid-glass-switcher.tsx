"use client";

import React, { useState, useEffect } from "react";
import "./apple-liquid-glass-switcher.css";

type Theme = "light" | "dark" | "dim";

interface ThemeSwitcherProps {
  defaultValue?: Theme;
  value?: Theme;
  onValueChange?: (theme: Theme) => void;
}

const iconProps = {
  className: "switcher__icon",
  xmlns: "http://www.w3.org/2000/svg",
  fill: "none",
  viewBox: "0 0 24 24",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const themeOptions: { value: Theme; cOption: string; icon: React.ReactNode }[] =
  [
    {
      value: "light",
      cOption: "1",
      icon: (
        <svg {...iconProps} aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2 12h2.2M19.8 12H22M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56" />
        </svg>
      ),
    },
    {
      value: "dark",
      cOption: "2",
      icon: (
        <svg {...iconProps} aria-hidden>
          <path d="M20.2 14.3A8.5 8.5 0 0 1 9.7 3.8 8.5 8.5 0 1 0 20.2 14.3Z" />
        </svg>
      ),
    },
    {
      value: "dim",
      cOption: "3",
      icon: (
        <svg {...iconProps} aria-hidden>
          <path d="M4 16h16" />
          <path d="M12 6v2.2M6.4 8.4l1.4 1.4M17.6 8.4l-1.4 1.4M8.5 16a3.5 3.5 0 0 1 7 0" />
        </svg>
      ),
    },
  ];

export function ThemeSwitcher({
  defaultValue = "light",
  value,
  onValueChange,
}: ThemeSwitcherProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [previousOption, setPreviousOption] = useState<string | null>(
    themeOptions.find((opt) => opt.value === (value ?? internalValue))
      ?.cOption || null
  );

  const activeValue = value ?? internalValue;

  useEffect(() => {
    if (value !== undefined) {
      setInternalValue(value);
    }
  }, [value]);

  const handleChange = (newValue: Theme) => {
    const currentOption = themeOptions.find(
      (opt) => opt.value === activeValue
    )?.cOption;
    setPreviousOption(currentOption || null);

    if (onValueChange) {
      onValueChange(newValue);
    } else {
      setInternalValue(newValue);
    }
  };

  return (
    <fieldset
      className="switcher"
      data-previous={previousOption ?? undefined}
    >
      <legend className="switcher__legend">Choose theme</legend>

      {themeOptions.map((option) => (
        <label key={option.value} className="switcher__option">
          <input
            className="switcher__input"
            type="radio"
            name="theme"
            value={option.value}
            data-c-option={option.cOption}
            checked={activeValue === option.value}
            onChange={() => handleChange(option.value)}
          />
          {option.icon}
        </label>
      ))}
    </fieldset>
  );
}
