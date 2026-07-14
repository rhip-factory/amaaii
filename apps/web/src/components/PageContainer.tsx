import type { ReactNode } from "react";
import styles from "./PageContainer.module.css";

interface PageContainerProps {
  title?: string;
  subhead?: string;
  children: ReactNode;
}

// Shared page padding + optional Fraunces title/subhead block, used by
// every (app) tab so spacing stays consistent without repeating markup.
export default function PageContainer({ title, subhead, children }: PageContainerProps) {
  return (
    <div className={styles.pad}>
      {title && (
        <div className={styles.head}>
          <h1 className={styles.title}>{title}</h1>
          {subhead && <p className={styles.subhead}>{subhead}</p>}
        </div>
      )}
      {children}
    </div>
  );
}
