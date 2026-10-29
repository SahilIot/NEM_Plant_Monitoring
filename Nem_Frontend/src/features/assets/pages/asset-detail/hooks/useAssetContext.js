import { useConfirmation } from "../../../../../components/common/UI.jsx";
import { useAuth } from "../../../../auth/AuthContext.jsx";
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";

// Router, auth and outlet context: who the user is and which asset is open.
export default function useAssetContext() {
  const confirm = useConfirmation();

  const { user } = useAuth();

  const isAdministrator = user?.role === "Administrator";

  const isSupervisor = user?.role === "Supervisor";

  const isOperator = user?.role === "Operator";

  const canManageRules = isAdministrator || isSupervisor;

  const canManageLogbook = canManageRules;

  const { id } = useParams();

  const location = useLocation();

  const navigate = useNavigate();

  const {
    assets,
    assetsLoaded,
    alerts = [],
    reload,
    refreshStatus,
  } = useOutletContext();

  const assetId = Number(id);

  const asset = assets.find((a) => a.id === assetId);

  return {
    confirm,
    isAdministrator,
    isSupervisor,
    isOperator,
    canManageRules,
    canManageLogbook,
    location,
    navigate,
    assets,
    assetsLoaded,
    reload,
    refreshStatus,
    alerts,
    assetId,
    asset,
  };
}
