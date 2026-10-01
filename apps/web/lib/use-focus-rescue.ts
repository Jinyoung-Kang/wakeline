"use client";
import { useCallback, useEffect, useRef } from "react";
import { rescueFocus } from "./focus-rescue";

type Targets = () => (Element | null | undefined)[];

/**
 * 조작 뒤 초점 되살리기(QA-304 — lib/focus-rescue 의 규칙을 그 조작에만): 처리기에서 request(targets) 를 부르면, 그 뒤 이 컴포넌트가 그릴 때마다
 * (ms 동안) 초점을 잃었는지 보고 targets() 가운데 처음 보이는 것으로 옮긴다 — 누른 단추가 그 그리기에서 사라지거나 비활성이 되거나, 응답을 받은 뒤
 * 사라져도 같다. 옮기면(또는 ms 가 지나면) 바라던 것을 지운다. 초점을 잃지 않았으면 옮기지 않는다(사용자가 다른 곳으로 옮겼으면 그대로).
 */
export function useFocusRescue(ms = 3_000): (targets: Targets) => void {
  const want = useRef<{ targets: Targets; until: number } | null>(null);
  useEffect(() => {
    const w = want.current;
    if (!w) return;
    if (Date.now() > w.until || rescueFocus(...w.targets())) want.current = null;
  });
  return useCallback((targets: Targets) => { want.current = { targets, until: Date.now() + ms }; }, [ms]);
}
