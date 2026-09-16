"use client";

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { getKeycapStyle, KEYBOARD_SPACE_GRAY } from "@/lib/download-theme";
import {
  IconBrightnessDown,
  IconBrightnessUp,
  IconCaretRightFilled,
  IconCaretUpFilled,
  IconChevronUp,
  IconMicrophone,
  IconMoon,
  IconPlayerSkipForward,
  IconPlayerTrackNext,
  IconPlayerTrackPrev,
  IconTable,
  IconVolume,
  IconVolume2,
  IconVolume3,
  IconSearch,
  IconWorld,
  IconCommand,
  IconCaretLeftFilled,
  IconCaretDownFilled,
} from "@tabler/icons-react";

const KEY_DISPLAY_LABELS: Record<string, string> = {
  Escape: "esc",
  Backspace: "delete",
  Tab: "tab",
  Enter: "return",
  ShiftLeft: "shift",
  ShiftRight: "shift",
  ControlLeft: "control",
  ControlRight: "control",
  AltLeft: "option",
  AltRight: "option",
  MetaLeft: "command",
  MetaRight: "command",
  Space: "space",
  CapsLock: "caps",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

const getKeyDisplayLabel = (keyCode: string): string => {
  if (KEY_DISPLAY_LABELS[keyCode]) return KEY_DISPLAY_LABELS[keyCode];
  if (keyCode.startsWith("Key")) return keyCode.slice(3);
  if (keyCode.startsWith("Digit")) return keyCode.slice(5);
  if (keyCode.startsWith("F") && keyCode.length <= 3) return keyCode;
  return keyCode;
};

interface KeyboardContextType {
  pressedKeys: Set<string>;
  setPressed: (keyCode: string) => void;
  setReleased: (keyCode: string) => void;
  lastPressedKey: string | null;
  highlightedKeys: Set<string>;
}

const KeyboardContext = createContext<KeyboardContextType | null>(null);

const useKeyboard = () => {
  const context = useContext(KeyboardContext);
  if (!context) {
    throw new Error("useKeyboard must be used within KeyboardProvider");
  }
  return context;
};

const KeyboardProvider = ({
  children,
  containerRef,
  highlightedKeys = [],
}: {
  children: React.ReactNode;
  containerRef: React.RefObject<HTMLDivElement | null>;
  highlightedKeys?: string[];
}) => {
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set());
  const [lastPressedKey, setLastPressedKey] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const highlightedSet = React.useMemo(() => new Set(highlightedKeys), [highlightedKeys]);

  const setPressed = useCallback((keyCode: string) => {
    setPressedKeys((prev) => new Set(prev).add(keyCode));
    setLastPressedKey(keyCode);
  }, []);

  const setReleased = useCallback((keyCode: string) => {
    setPressedKeys((prev) => {
      const next = new Set(prev);
      next.delete(keyCode);
      return next;
    });
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { threshold: 0.1 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      setPressed(e.code);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      setReleased(e.code);
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
    };
  }, [isVisible, setPressed, setReleased]);

  return (
    <KeyboardContext.Provider
      value={{
        pressedKeys,
        setPressed,
        setReleased,
        lastPressedKey,
        highlightedKeys: highlightedSet,
      }}
    >
      {children}
    </KeyboardContext.Provider>
  );
};

const KeystrokePreview = () => {
  const { lastPressedKey, pressedKeys } = useKeyboard();
  const [displayKey, setDisplayKey] = useState<string | null>(null);
  const [animationKey, setAnimationKey] = useState(0);

  useEffect(() => {
    if (!lastPressedKey) return;
    if (["Space", "ShiftLeft", "ShiftRight"].includes(lastPressedKey)) {
      setDisplayKey(null);
      return;
    }
    setDisplayKey(getKeyDisplayLabel(lastPressedKey));
    setAnimationKey((prev) => prev + 1);
  }, [lastPressedKey]);

  const isPressed = pressedKeys.size > 0;

  return (
    <div className="relative flex h-12 w-full items-center justify-center">
      <AnimatePresence mode="popLayout">
        {displayKey ? (
          <motion.div
            key={animationKey}
            layout
            initial={{ opacity: 0, scale: 0.5, y: 5 }}
            animate={{ opacity: 1, scale: isPressed ? 0.95 : 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: -5 }}
            transition={{ type: "spring", stiffness: 500, damping: 30, mass: 0.5 }}
            className="absolute flex items-center justify-center rounded-lg px-4 py-2 font-mono text-2xl font-black text-white/70"
          >
            <motion.span
              initial={{ opacity: 0, scale: 1.2, filter: "blur(10px)" }}
              animate={{ opacity: 0.8, scale: 1, filter: "blur(0px)" }}
              transition={{ duration: 0.05 }}
            >
              {displayKey}
            </motion.span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
};

export function Keyboard({
  className,
  showPreview = false,
  highlightedKeys = [],
}: {
  className?: string;
  showPreview?: boolean;
  highlightedKeys?: string[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <KeyboardProvider containerRef={containerRef} highlightedKeys={highlightedKeys}>
      <div
        ref={containerRef}
        className={cn(
          "mx-auto w-fit [zoom:0.65] sm:[zoom:0.85] md:[zoom:1] lg:[zoom:1.15]",
          className,
        )}
      >
        {showPreview ? <KeystrokePreview /> : null}
        <Keypad />
      </div>
    </KeyboardProvider>
  );
}

const KEY_BASE =
  "flex cursor-pointer items-center justify-center rounded-[3.5px] border-0 shadow-none transition-transform duration-75 active:scale-[0.98]";

function keyClasses({
  className,
}: {
  className?: string;
  isPressed?: boolean;
  isHighlighted?: boolean;
}) {
  return cn(KEY_BASE, className);
}

export const Keypad = () => (
  <div
    className="h-full w-fit rounded-xl p-1"
    style={{
      background: KEYBOARD_SPACE_GRAY.chassisGradient,
      boxShadow: KEYBOARD_SPACE_GRAY.chassisShadow,
    }}
  >
    <Row>
      <Key keyCode="Escape" containerClassName="rounded-tl-xl" className="w-10 rounded-tl-lg" childrenClassName="items-start justify-end pb-[2px] pl-[4px]">
        <span>esc</span>
      </Key>
      <Key keyCode="F1"><IconBrightnessDown className="h-[6px] w-[6px]" /><span className="mt-1">F1</span></Key>
      <Key keyCode="F2"><IconBrightnessUp className="h-[6px] w-[6px]" /><span className="mt-1">F2</span></Key>
      <Key keyCode="F3"><IconTable className="h-[6px] w-[6px]" /><span className="mt-1">F3</span></Key>
      <Key keyCode="F4"><IconSearch className="h-[6px] w-[6px]" /><span className="mt-1">F4</span></Key>
      <Key keyCode="F5"><IconMicrophone className="h-[6px] w-[6px]" /><span className="mt-1">F5</span></Key>
      <Key keyCode="F6"><IconMoon className="h-[6px] w-[6px]" /><span className="mt-1">F6</span></Key>
      <Key keyCode="F7"><IconPlayerTrackPrev className="h-[6px] w-[6px]" /><span className="mt-1">F7</span></Key>
      <Key keyCode="F8"><IconPlayerSkipForward className="h-[6px] w-[6px]" /><span className="mt-1">F8</span></Key>
      <Key keyCode="F9"><IconPlayerTrackNext className="h-[6px] w-[6px]" /><span className="mt-1">F9</span></Key>
      <Key keyCode="F10"><IconVolume3 className="h-[6px] w-[6px]" /><span className="mt-1">F10</span></Key>
      <Key keyCode="F11"><IconVolume2 className="h-[6px] w-[6px]" /><span className="mt-1">F11</span></Key>
      <Key keyCode="F12"><IconVolume className="h-[6px] w-[6px]" /><span className="mt-1">F12</span></Key>
      <Key containerClassName="rounded-tr-xl" className="rounded-tr-lg">
        <div
          className="h-4 w-4 rounded-full p-px"
          style={{
            background: KEYBOARD_SPACE_GRAY.keyGradient,
            boxShadow: KEYBOARD_SPACE_GRAY.keyShadow,
          }}
        >
          <div
            className="h-full w-full rounded-full"
            style={{ background: "linear-gradient(180deg, #2a2a2c 0%, #141416 100%)" }}
          />
        </div>
      </Key>
    </Row>

    <Row>
      <Key keyCode="Backquote"><span>~</span><span>`</span></Key>
      <Key keyCode="Digit1"><span>!</span><span>1</span></Key>
      <Key keyCode="Digit2"><span>@</span><span>2</span></Key>
      <Key keyCode="Digit3"><span>#</span><span>3</span></Key>
      <Key keyCode="Digit4"><span>$</span><span>4</span></Key>
      <Key keyCode="Digit5"><span>%</span><span>5</span></Key>
      <Key keyCode="Digit6"><span>^</span><span>6</span></Key>
      <Key keyCode="Digit7"><span>&</span><span>7</span></Key>
      <Key keyCode="Digit8"><span>*</span><span>8</span></Key>
      <Key keyCode="Digit9"><span>(</span><span>9</span></Key>
      <Key keyCode="Digit0"><span>)</span><span>0</span></Key>
      <Key keyCode="Minus"><span>—</span><span>_</span></Key>
      <Key keyCode="Equal"><span>+</span><span>=</span></Key>
      <Key keyCode="Backspace" className="w-10" childrenClassName="items-end justify-end pr-[4px] pb-[2px]"><span>delete</span></Key>
    </Row>

    <Row>
      <Key keyCode="Tab" className="w-10" childrenClassName="items-start justify-end pb-[2px] pl-[4px]"><span>tab</span></Key>
      {["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"].map((letter) => (
        <Key key={letter} keyCode={`Key${letter}`}>{letter}</Key>
      ))}
      <Key keyCode="BracketLeft"><span>{`{`}</span><span>{`[`}</span></Key>
      <Key keyCode="BracketRight"><span>{`}`}</span><span>{`]`}</span></Key>
      <Key keyCode="Backslash"><span>{`|`}</span><span>{`\\`}</span></Key>
    </Row>

    <Row>
      <Key keyCode="CapsLock" className="w-[2.8rem]" childrenClassName="items-start justify-end pb-[2px] pl-[4px]"><span>caps lock</span></Key>
      {["A", "S", "D", "F", "G", "H", "J", "K", "L"].map((letter) => (
        <Key key={letter} keyCode={`Key${letter}`}>{letter}</Key>
      ))}
      <Key keyCode="Semicolon"><span>:</span><span>;</span></Key>
      <Key keyCode="Quote"><span>{`"`}</span><span>{`'`}</span></Key>
      <Key keyCode="Enter" className="w-[2.85rem]" childrenClassName="items-end justify-end pr-[4px] pb-[2px]"><span>return</span></Key>
    </Row>

    <Row>
      <Key keyCode="ShiftLeft" className="w-[3.65rem]" childrenClassName="items-start justify-end pb-[2px] pl-[4px]"><span>shift</span></Key>
      {["Z", "X", "C", "V", "B", "N", "M"].map((letter) => (
        <Key key={letter} keyCode={`Key${letter}`}>{letter}</Key>
      ))}
      <Key keyCode="Comma"><span>{`<`}</span><span>,</span></Key>
      <Key keyCode="Period"><span>{`>`}</span><span>.</span></Key>
      <Key keyCode="Slash"><span>?</span><span>/</span></Key>
      <Key keyCode="ShiftRight" className="w-[3.65rem]" childrenClassName="items-end justify-end pr-[4px] pb-[2px]"><span>shift</span></Key>
    </Row>

    <Row>
      <ModifierKey keyCode="Fn" containerClassName="rounded-bl-xl" className="rounded-bl-lg"><span>fn</span><IconWorld className="h-[6px] w-[6px]" /></ModifierKey>
      <ModifierKey keyCode="ControlLeft"><IconChevronUp className="h-[6px] w-[6px]" /><span>control</span></ModifierKey>
      <ModifierKey keyCode="AltLeft"><OptionKey className="h-[6px] w-[6px]" /><span>option</span></ModifierKey>
      <ModifierKey keyCode="MetaLeft" className="w-8"><IconCommand className="h-[6px] w-[6px]" /><span>command</span></ModifierKey>
      <Key keyCode="Space" className="w-[8.2rem]" />
      <ModifierKey keyCode="MetaRight" className="w-8"><IconCommand className="h-[6px] w-[6px]" /><span>command</span></ModifierKey>
      <ModifierKey keyCode="AltRight"><OptionKey className="h-[6px] w-[6px]" /><span>option</span></ModifierKey>
      <div className="flex h-6 w-[4.9rem] items-center justify-end rounded-[4px] p-[0.5px]">
        <Key keyCode="ArrowLeft" className="h-6 w-6"><IconCaretLeftFilled className="h-[6px] w-[6px]" /></Key>
        <div className="flex flex-col">
          <Key keyCode="ArrowUp" className="h-3 w-6"><IconCaretUpFilled className="h-[6px] w-[6px]" /></Key>
          <Key keyCode="ArrowDown" className="h-3 w-6"><IconCaretDownFilled className="h-[6px] w-[6px]" /></Key>
        </div>
        <Key keyCode="ArrowRight" containerClassName="rounded-br-xl" className="h-6 w-6 rounded-br-lg">
          <IconCaretRightFilled className="h-[6px] w-[6px]" />
        </Key>
      </div>
    </Row>
  </div>
);

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-[2px] flex w-full shrink-0 gap-[2px]">{children}</div>
);

const Key = ({
  className,
  childrenClassName,
  containerClassName,
  children,
  keyCode,
}: {
  className?: string;
  childrenClassName?: string;
  containerClassName?: string;
  children?: React.ReactNode;
  keyCode?: string;
}) => {
  const { pressedKeys, setPressed, setReleased, highlightedKeys } = useKeyboard();
  const isPressed = keyCode ? pressedKeys.has(keyCode) : false;
  const isHighlighted = keyCode ? highlightedKeys.has(keyCode) : false;

  return (
    <div className={cn("rounded-[4px] p-[0.5px]", containerClassName)}>
      <button
        type="button"
        onMouseDown={() => keyCode && setPressed(keyCode)}
        onMouseUp={() => keyCode && isPressed && setReleased(keyCode)}
        onMouseLeave={() => keyCode && isPressed && setReleased(keyCode)}
        className={keyClasses({ className: cn("h-6 w-6", className) })}
        style={getKeycapStyle({ isPressed, isHighlighted })}
      >
        <div
          className={cn("flex h-full w-full flex-col items-center justify-center text-[5px]", childrenClassName)}
          style={{ color: "inherit" }}
        >
          {children}
        </div>
      </button>
    </div>
  );
};

const ModifierKey = ({
  className,
  containerClassName,
  children,
  keyCode,
}: {
  className?: string;
  containerClassName?: string;
  children?: React.ReactNode;
  keyCode?: string;
}) => {
  const { pressedKeys, setPressed, setReleased, highlightedKeys } = useKeyboard();
  const isPressed = keyCode ? pressedKeys.has(keyCode) : false;
  const isHighlighted = keyCode ? highlightedKeys.has(keyCode) : false;

  return (
    <div className={cn("rounded-[4px] p-[0.5px]", containerClassName)}>
      <button
        type="button"
        onMouseDown={() => keyCode && setPressed(keyCode)}
        onMouseUp={() => keyCode && isPressed && setReleased(keyCode)}
        onMouseLeave={() => keyCode && isPressed && setReleased(keyCode)}
        className={keyClasses({ className: cn("h-6 w-6", className) })}
        style={getKeycapStyle({ isPressed, isHighlighted })}
      >
        <div
          className="flex h-full w-full flex-col items-start justify-between p-1 text-[5px]"
          style={{ color: "inherit" }}
        >
          {children}
        </div>
      </button>
    </div>
  );
};

function OptionKey({ className }: { className?: string }) {
  return (
    <svg fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className={className}>
      <rect stroke="currentColor" strokeWidth={2} x="18" y="5" width="10" height="2" />
      <polygon
        stroke="currentColor"
        strokeWidth={2}
        points="10.6,5 4,5 4,7 9.4,7 18.4,27 28,27 28,25 19.6,25"
      />
    </svg>
  );
}
