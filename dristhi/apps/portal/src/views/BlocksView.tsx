import React, { useEffect, useState } from "react";
import { Card, Table, Button, Badge } from "@drishti/ui";
import { api, Block } from "../api";
import { DEMO_BLOCKS } from "../demoData";
import type { Role } from "../auth";

const toneFor = (status: string) =>
  status === "approved" ? "success" : status === "flagged" ? "danger" : "warning";

export function BlocksView({ role }: { role: Role }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [live, setLive] = useState(true);

  const load = async () => {
    try {
      setBlocks(await api.listBlocks());
      setLive(true);
    } catch {
      setBlocks(DEMO_BLOCKS);
      setLive(false);
    }
  };

  useEffect(() => { load(); }, []);

  const act = async (id: string, action: "approve" | "flag") => {
    try {
      if (action === "approve") await api.approve(id);
      else await api.flag(id);
      await load();
    } catch {
      setBlocks((b) => b.map((x) => (x.block_id === id ? { ...x, status: action === "approve" ? "approved" : "flagged" } : x)));
    }
  };

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Block Measurements</h2>
        {!live && <Badge tone="warning">offline demo data (gateway not reachable)</Badge>}
      </div>
      <Table
        columns={["Block ID", "Quarry", "L×W×H (m)", "Volume", "Class", "Conf.", "Fee (INR)", "Status", ""]}
        rows={blocks.map((b) => [
          b.block_id,
          b.quarry_id,
          `${b.length_m} × ${b.width_m} × ${b.height_m}`,
          `${b.volume_m3} m³`,
          b.classification.replace("_", " "),
          `${Math.round(b.confidence * 100)}%`,
          b.seigniorage_fee_inr.toLocaleString("en-IN"),
          <Badge tone={toneFor(b.status)}>{b.status}</Badge>,
          b.status === "pending" && role !== "operator" ? (
            <span style={{ display: "flex", gap: 8 }}>
              <Button variant="success" onClick={() => act(b.block_id, "approve")}>Approve</Button>
              <Button variant="danger" onClick={() => act(b.block_id, "flag")}>Flag</Button>
            </span>
          ) : (
            <span style={{ color: "var(--sos-text-muted)" }}>—</span>
          ),
        ])}
      />
    </Card>
  );
}
