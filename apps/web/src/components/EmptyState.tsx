import Link from "next/link";
import type { ComponentType, SVGProps } from "react";
import styles from "./EmptyState.module.css";

interface EmptyStateProps {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
  ctaLabel?: string;
  ctaHref?: string;
}

export default function EmptyState({ Icon, title, body, ctaLabel, ctaHref }: EmptyStateProps) {
  return (
    <div className={styles.wrap}>
      <Icon className={styles.icon} />
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.body}>{body}</p>
      {ctaLabel && ctaHref && (
        <Link href={ctaHref} className={styles.cta}>
          {ctaLabel}
        </Link>
      )}
    </div>
  );
}
