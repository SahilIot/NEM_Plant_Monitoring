import useAssetContext from "./hooks/useAssetContext.js";
import useAssetState from "./hooks/useAssetState.js";
import useDropdownDismiss from "./hooks/useDropdownDismiss.js";
import useAssetData from "./hooks/useAssetData.js";
import useAssetEffects from "./hooks/useAssetEffects.js";
import useRuleList from "./hooks/useRuleList.js";
import useEventLog from "./hooks/useEventLog.js";
import useMaintenanceLog from "./hooks/useMaintenanceLog.js";
import useExcelExport from "./hooks/useExcelExport.js";
import useRuleActions from "./hooks/useRuleActions.js";
import useAssetActions from "./hooks/useAssetActions.js";

// Runs the smaller hooks in a fixed order (same order as the original code).
// Each hook receives everything the earlier hooks returned, and the final
// `ctx` object is passed to the UI components of this page.
export default function useAssetDetail() {
  const ctx = {};
  Object.assign(ctx, useAssetContext());
  Object.assign(ctx, useAssetState(ctx));
  Object.assign(ctx, useDropdownDismiss(ctx));
  Object.assign(ctx, useAssetData(ctx));
  Object.assign(ctx, useAssetEffects(ctx));
  Object.assign(ctx, useRuleList(ctx));
  Object.assign(ctx, useEventLog(ctx));
  Object.assign(ctx, useMaintenanceLog(ctx));
  Object.assign(ctx, useExcelExport(ctx));
  Object.assign(ctx, useRuleActions(ctx));
  Object.assign(ctx, useAssetActions(ctx));
  return ctx;
}
