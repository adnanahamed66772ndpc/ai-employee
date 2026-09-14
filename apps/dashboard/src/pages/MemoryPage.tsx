import { MemoryPanel } from "../components/MemoryPanel.tsx";

export function MemoryPage() {
  return (
    <div className="page">
      <header className="page-head">
        <h1>Global memory</h1>
        <p className="lede">Your preferences that every agent follows in every project. Facts about one repository belong in that project's memory.</p>
      </header>
      <MemoryPanel scope="global" title="Saved preferences" description="Agents read these before planning, coding and reviewing." />
    </div>
  );
}
