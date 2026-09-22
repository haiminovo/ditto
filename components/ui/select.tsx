"use client";

import * as React from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Check, ChevronDown } from "lucide-react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 自绘下拉选择器（listbox）。
 *
 * 为什么不用原生 <select>：展开后的面板由操作系统渲染，CSS 完全碰不到 ——
 * 深色模式下白底刺眼、选中项是系统灰、圆角和字体都跟界面脱节。
 * 这个组件把闭合态和展开态都收进设计系统里。
 *
 * 键盘交互、typeahead、aria 都按 WAI-ARIA 的 select-only combobox 模式实现，
 * 用 aria-activedescendant 传递高亮，DOM 焦点始终留在触发器上，
 * 因此不需要在面板里做焦点陷阱。
 */

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  /** 灰显且不可选中 */
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** 值为空时显示的灰色占位文案 */
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

/** 与面板的 max-h 保持一致，用于判断向下弹出是否会溢出视口 */
const PANEL_MAX_HEIGHT = 260;
/** 估算单行高度，同样只用于溢出判断 */
const OPTION_HEIGHT = 34;

export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  id,
  className,
  ...aria
}: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [dropUp, setDropUp] = React.useState(false);

  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const optionRefs = React.useRef<(HTMLLIElement | null)[]>([]);
  const typeahead = React.useRef({ buffer: "", at: 0 });

  // useId 会带冒号，直接拼进 id 里虽合法但不利于调试，去掉
  const uid = React.useId().replace(/:/g, "");
  const listId = `${id ?? uid}-list`;

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const openPanel = React.useCallback(() => {
    const start = selectedIndex >= 0 ? selectedIndex : options.findIndex((o) => !o.disabled);
    setActiveIndex(start);

    // 空间不够就向上弹。下方实在没地方（比如面板本身就比视口高）时仍向下，
    // 面板内部可滚动，至少不至于完全看不到。
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const needed = Math.min(PANEL_MAX_HEIGHT, options.length * OPTION_HEIGHT + 10);
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      setDropUp(below < needed && above > below);
    }

    setOpen(true);
  }, [options, selectedIndex]);

  const commit = React.useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      setOpen(false);
      // 点击选项后焦点默认落在 body 上，还回触发器，键盘用户才不会掉队
      triggerRef.current?.focus();
    },
    [onChange, options]
  );

  /** 跳过 disabled 项移动高亮；全禁用时原地不动 */
  const moveActive = React.useCallback(
    (delta: number) => {
      if (options.length === 0) return;
      // -1 是"无高亮"，向下应落到 0，向上应落到末项
      let next = activeIndex < 0 ? (delta > 0 ? -1 : 0) : activeIndex;
      for (let i = 0; i < options.length; i++) {
        next = (next + delta + options.length) % options.length;
        if (!options[next].disabled) break;
      }
      setActiveIndex(next);
    },
    [activeIndex, options]
  );

  /** 首字母跳转，对标原生 select 的 typeahead */
  const search = React.useCallback(
    (char: string) => {
      const now = Date.now();
      const t = typeahead.current;
      t.buffer = now - t.at > 600 ? char : t.buffer + char;
      t.at = now;

      const query = t.buffer.toLowerCase();
      const from = activeIndex < 0 ? -1 : activeIndex;
      for (let i = 1; i <= options.length; i++) {
        const index = (from + i + options.length) % options.length;
        const option = options[index];
        const label = typeof option.label === "string" ? option.label.toLowerCase() : "";
        if (!option.disabled && label.startsWith(query)) {
          setActiveIndex(index);
          return true;
        }
      }
      return false;
    },
    [activeIndex, options]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        open ? moveActive(1) : openPanel();
        return;
      case "ArrowUp":
        e.preventDefault();
        open ? moveActive(-1) : openPanel();
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        // 空格在按钮上默认会触发 click，会跟这里的逻辑打架
        if (!open) openPanel();
        else commit(activeIndex);
        return;
      case "Escape":
        if (!open) return;
        // 阻止冒泡：外层若有弹窗/抽屉，不该被这个 Esc 一起关掉
        e.stopPropagation();
        setOpen(false);
        return;
      case "Home":
        if (!open) return;
        e.preventDefault();
        setActiveIndex(options.findIndex((o) => !o.disabled));
        return;
      case "End":
        if (!open) return;
        e.preventDefault();
        setActiveIndex(
          options.length - 1 - [...options].reverse().findIndex((o) => !o.disabled)
        );
        return;
      case "Tab":
        // 让焦点自然移走，只是把面板收起来
        setOpen(false);
        return;
    }

    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (!open) openPanel();
      if (search(e.key)) e.preventDefault();
    }
  };

  // 点击组件之外关闭。用 pointerdown 而非 click：拖拽选中的松手位置在外部时
  // 不该被当成"点了外面"
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // 键盘移动高亮时把该项滚进可视区
  React.useEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(e) => {
        // 焦点离开整个组件（比如 Tab 出去）就收起来
        if (!rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined
        }
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={handleKeyDown}
        className={cn(
          "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 transition-colors",
          "hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-50 dark:hover:border-gray-600",
          "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-950",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate text-left", !selected && "text-gray-400 dark:text-gray-500")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          className={cn(
            "absolute z-50 max-h-[260px] w-full overflow-y-auto rounded-md border border-gray-200 bg-white p-1 shadow-lg",
            "dark:border-gray-700 dark:bg-gray-900",
            dropUp ? "bottom-full mb-1 animate-select-up" : "top-full mt-1 animate-select-down"
          )}
        >
          {options.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-gray-400 dark:text-gray-500">暂无可选项</li>
          ) : (
            options.map((option, index) => {
              const isSelected = option.value === value;
              const isActive = index === activeIndex;
              return (
                <li
                  key={option.value}
                  id={`${listId}-option-${index}`}
                  ref={(el) => {
                    optionRefs.current[index] = el;
                  }}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  onClick={() => commit(index)}
                  // 阻止 mousedown 抢焦点：否则焦点从触发器移到 body，触发下面的
                  // onBlur 收起面板，<li> 在 click 事件到达前就被卸载了 —— 表现为
                  // "点了选项，面板关了，但值没变"。
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
                    option.disabled && "cursor-not-allowed opacity-40",
                    isSelected
                      ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                      : "text-gray-700 dark:text-gray-300",
                    !isSelected && isActive && "bg-gray-100 dark:bg-gray-800"
                  )}
                >
                  <Check
                    aria-hidden="true"
                    className={cn(
                      "h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400",
                      !isSelected && "opacity-0"
                    )}
                  />
                  <span className="truncate">{option.label}</span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
