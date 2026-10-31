import * as React from "react";
import { clsx } from "clsx";

export function Select({
  children,
  value,
  onValueChange,
  className,
  ...props
}: {
  children: React.ReactNode;
  value: string;
  onValueChange: (v: string) => void;
  className?: string;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">) {
  return (
    <select
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      className={clsx(
        "border border-border/50 bg-background/80 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function SelectTrigger({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={clsx(
        "flex items-center justify-between gap-2 border border-border/50 bg-background/80 px-3 py-2",
        className
      )}
    >
      {children}
    </div>
  );
}

export function SelectContent({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-1">{children}</div>;
}

export function SelectItem({
  value,
  children,
  onValueChange,
}: {
  value: string;
  children: React.ReactNode;
  onValueChange: (v: string) => void;
}) {
  const isActive = value === "connected";
  return (
    <button
      className={clsx(
        "w-full flex justify-between gap-2 px-3 py-2 text-sm transition-colors",
        isActive ? "bg-accent/10 text-accent" : "text-foreground hover:bg-muted/50"
      )}
      onClick={() => onValueChange(value)}
    >
      {children}
      <span className="text-xs text-muted-foreground">{value}</span>
    </button>
  );
}

export function SelectValue({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}
