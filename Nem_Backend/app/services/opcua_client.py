import hashlib
import ipaddress
import logging # Records diagonostic messages without printing sensitive details
import os
from dataclasses import dataclass # creates a convenient class for storing related data
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from asyncua import Client, ua # Provides the OPC UA client connection and protocol types
from asyncua.crypto import security_policies
from asyncua.crypto.uacrypto import CertProperties
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from app.core.config import Settings # application`s configuration class, which supplies connection settings

LOGGER = logging.getLogger("nem_backend.opcua")

#Tracking subscription settings
class _ConfiguredOpcUaClient(Client):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.last_subscription_result: ua.CreateSubscriptionResult | None = None

    def get_subscription_revised_params(self,
        params: ua.CreateSubscriptionParameters,
        results: ua.CreateSubscriptionResult,
    ) -> ua.ModifySubscriptionParameters | None:
        self.last_subscription_result = results
        return super().get_subscription_revised_params(params, results)
    
 #Separating configuration errors from communication errors
class OpcUaConfigurationError(RuntimeError):
    pass

#an OPC UA connection or reading operation failed.
class OpcUaConnectionError(RuntimeError):
    pass

@dataclass(frozen=True)
class OpcUaRead:
    value: object
    source_timestamp: datetime | None
    server_timestamp: datetime | None

# Validate the endpoint and optional username/password before connecting.
def _validate_connection_settings(settings: Settings) -> str:
    endpoint = settings.opcua_endpoint.strip()
    try:
        parsed_endpoint = urlsplit(endpoint)
        port = parsed_endpoint.port
    except ValueError as error:
        raise OpcUaConfigurationError("OPCUA_ENDPOINT is not a valid OPC UA endpoint URL.") from error
    if (
        parsed_endpoint.scheme.lower() != "opc.tcp"
        or not parsed_endpoint.hostname
        or port is None
        or parsed_endpoint.username is not None
        or parsed_endpoint.password is not None
        or parsed_endpoint.query
        or parsed_endpoint.fragment
    ):
        raise OpcUaConfigurationError("Set OPCUA_ENDPOINT to the opc.tcp:// endpoint supplied by the PLC engineer; do not place credentials in the URL.")

    username = settings.opcua_username.strip()
    password = settings.opcua_password.get_secret_value()
    if bool(username) != bool(password):
        raise OpcUaConfigurationError("Configure both OPCUA_USERNAME and OPCUA_PASSWORD, or leave both empty.")
    return endpoint

# function converts a low-level exception into a more controlled error message, without exposing sensitive information like credentials or file paths. It logs the error type for diagnostics while returning a generic connection error to the caller.

def _safe_connection_error(error: Exception) -> OpcUaConnectionError:
    LOGGER.error("OPC UA operation failed",exc_info=(type(error), error, error.__traceback__),)
    return OpcUaConnectionError(f"OPC UA operation failed ({type(error).__name__}).")

# ---------------------------------------------------------------------------
# Transport security (read-only client; nothing here ever writes to the PLC)
# ---------------------------------------------------------------------------
_SECURITY_POLICIES = {
    "Basic256Sha256": security_policies.SecurityPolicyBasic256Sha256,
    "Aes128Sha256RsaOaep": security_policies.SecurityPolicyAes128Sha256RsaOaep,
    "Aes256Sha256RsaPss": security_policies.SecurityPolicyAes256Sha256RsaPss,
}
_SECURITY_MODES = {
    "Sign": ua.MessageSecurityMode.Sign,
    "SignAndEncrypt": ua.MessageSecurityMode.SignAndEncrypt,
}
_CERTIFICATE_SUFFIXES = {".pem", ".crt", ".cer", ".der"}
_insecure_transport_warned = False


def opcua_security_summary(settings: Settings) -> dict[str, object]:
    """Non-secret description of the configured transport security (safe for API responses)."""
    secure = settings.opcua_security_mode != "None"
    return {
        "mode": settings.opcua_security_mode,
        "policy": settings.opcua_security_policy if secure else "None",
        "signed": secure,
        "encrypted": settings.opcua_security_mode == "SignAndEncrypt",
        "server_certificate_validated": False,
        "secure_transport_required": settings.opcua_require_secure_transport,
    }


def _require_file(value: str, setting: str) -> Path:
    if not value.strip():
        raise OpcUaConfigurationError(f"Set {setting} when OPCUA_SECURITY_MODE is Sign or SignAndEncrypt.")
    path = Path(value.strip()).expanduser()
    if not path.is_file():
        raise OpcUaConfigurationError(f"{setting} does not point to a readable file.")
    return path


def _parse_certificate(data: bytes) -> x509.Certificate:
    if b"-----BEGIN" in data:
        return x509.load_pem_x509_certificate(data)
    return x509.load_der_x509_certificate(data)


def _validity_problem(certificate: x509.Certificate) -> str | None:
    now = datetime.now(timezone.utc)
    if certificate.not_valid_after_utc < now:
        return "has expired"
    if certificate.not_valid_before_utc > now:
        return "is not valid yet"
    return None


def _check_private_key_file(path: Path) -> None:
    # POSIX only: a key readable by group/other defeats the point of the key.
    if os.name == "posix" and path.stat().st_mode & 0o077:
        raise OpcUaConfigurationError(
            "OPCUA_CLIENT_PRIVATE_KEY_PATH is readable by other users; restrict it to the service account (for example chmod 600)."
        )


def _load_client_identity(settings: Settings) -> tuple[CertProperties, CertProperties, str | None]:
    """Validate the client certificate/key pair and return asyncua inputs. Secrets are never logged."""
    cert_path = _require_file(settings.opcua_client_certificate_path, "OPCUA_CLIENT_CERTIFICATE_PATH")
    key_path = _require_file(settings.opcua_client_private_key_path, "OPCUA_CLIENT_PRIVATE_KEY_PATH")
    _check_private_key_file(key_path)
    password = settings.opcua_client_private_key_password.get_secret_value() or None

    cert_bytes = cert_path.read_bytes()
    try:
        certificate = _parse_certificate(cert_bytes)
    except ValueError as error:
        raise OpcUaConfigurationError("OPCUA_CLIENT_CERTIFICATE_PATH is not a valid PEM or DER certificate.") from error
    problem = _validity_problem(certificate)
    if problem:
        raise OpcUaConfigurationError(f"The OPC UA client certificate {problem}; issue a new one.")

    key_bytes = key_path.read_bytes()
    try:
        loader = serialization.load_pem_private_key if b"-----BEGIN" in key_bytes else serialization.load_der_private_key
        private_key = loader(key_bytes, password=password.encode("utf-8") if password else None)
    except Exception as error:  # wrong password, wrong format, unsupported key: never echo details
        raise OpcUaConfigurationError(
            "OPCUA_CLIENT_PRIVATE_KEY_PATH could not be loaded; check the file format and OPCUA_CLIENT_PRIVATE_KEY_PASSWORD."
        ) from error
    public = serialization.PublicFormat.SubjectPublicKeyInfo
    der = serialization.Encoding.DER
    if private_key.public_key().public_bytes(der, public) != certificate.public_key().public_bytes(der, public):
        raise OpcUaConfigurationError("The OPC UA client private key does not match the client certificate.")

    return (
        CertProperties(cert_bytes, "pem" if b"-----BEGIN" in cert_bytes else "der"),
        CertProperties(key_bytes, "pem" if b"-----BEGIN" in key_bytes else "der", password),
        password,
    )


def _load_trusted_server_certificates(settings: Settings) -> dict[str, x509.Certificate]:
    """SHA-256 fingerprint -> certificate for every certificate the operator chose to trust."""
    location = settings.opcua_trusted_server_certificates.strip()
    if not location:
        raise OpcUaConfigurationError(
            "Set OPCUA_TRUSTED_SERVER_CERTIFICATES to the PLC server certificate file or a directory of trusted certificates."
        )
    root = Path(location).expanduser()
    if root.is_dir():
        files = sorted(p for p in root.iterdir() if p.is_file() and p.suffix.lower() in _CERTIFICATE_SUFFIXES)
    elif root.is_file():
        files = [root]
    else:
        raise OpcUaConfigurationError("OPCUA_TRUSTED_SERVER_CERTIFICATES does not exist.")
    trusted: dict[str, x509.Certificate] = {}
    for file in files:
        try:
            certificate = _parse_certificate(file.read_bytes())
        except ValueError:
            LOGGER.warning("Ignoring unreadable trusted OPC UA certificate file %s", file.name)
            continue
        trusted[hashlib.sha256(certificate.public_bytes(serialization.Encoding.DER)).hexdigest()] = certificate
    if not trusted:
        raise OpcUaConfigurationError("OPCUA_TRUSTED_SERVER_CERTIFICATES contains no readable certificates.")
    return trusted


async def _discover_server_certificate(settings: Settings, endpoint: str, policy, mode) -> bytes:
    """Ask the server which certificate it uses for the configured policy/mode.

    Discovery uses an unsecured channel but only transfers public endpoint data. Nothing
    is trusted from it: the certificate is checked against the operator's trust list and
    then pinned, so the secure session fails if the server presents a different one.
    """
    discovery = Client(url=endpoint, timeout=settings.opcua_timeout_seconds)
    try:
        endpoints = await discovery.connect_and_get_server_endpoints()
    except Exception as error:
        raise _safe_connection_error(error) from error
    try:
        found = Client.find_endpoint(endpoints, mode, policy.URI)
    except ua.UaError as error:
        raise OpcUaConfigurationError(
            "The OPC UA server does not offer the configured OPCUA_SECURITY_POLICY / OPCUA_SECURITY_MODE."
        ) from error
    raw = found.ServerCertificate
    if not raw:
        raise OpcUaConnectionError("The OPC UA server did not present a certificate for the secure endpoint.")
    length = int.from_bytes(raw[2:4], byteorder="big", signed=False) + 4  # drop any chained certificates
    return bytes(raw[:length])


def _verify_server_certificate(der: bytes, trusted: dict[str, x509.Certificate], endpoint: str, check_hostname: bool) -> None:
    try:
        certificate = x509.load_der_x509_certificate(der)
    except ValueError as error:
        raise OpcUaConnectionError("The OPC UA server presented an unreadable certificate.") from error
    fingerprint = hashlib.sha256(der).hexdigest()
    if fingerprint not in trusted:
        LOGGER.warning("Rejected untrusted OPC UA server certificate (sha256 %s).", fingerprint)
        raise OpcUaConnectionError(
            "The OPC UA server certificate is not trusted. Verify its fingerprint with the PLC engineer, "
            "then add it to OPCUA_TRUSTED_SERVER_CERTIFICATES."
        )
    problem = _validity_problem(certificate)
    if problem:
        raise OpcUaConnectionError(f"The OPC UA server certificate {problem}; renew it on the server and in the trust list.")
    if check_hostname:
        host = urlsplit(endpoint).hostname or ""
        try:
            san = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        except x509.ExtensionNotFound:
            san = None
        names = {n.lower() for n in san.get_values_for_type(x509.DNSName)} if san else set()
        addresses = {str(a) for a in san.get_values_for_type(x509.IPAddress)} if san else set()
        try:
            matches = str(ipaddress.ip_address(host)) in addresses
        except ValueError:
            matches = host.lower() in names
        if not matches:
            raise OpcUaConnectionError(
                "The OPC UA server certificate does not match the host in OPCUA_ENDPOINT "
                "(set OPCUA_CHECK_SERVER_HOSTNAME=false only if the PLC certificate cannot carry the host name)."
            )


async def _configure_secure_channel(client: Client, settings: Settings, endpoint: str) -> None:
    policy = _SECURITY_POLICIES[settings.opcua_security_policy]
    mode = _SECURITY_MODES[settings.opcua_security_mode]
    certificate, private_key, password = _load_client_identity(settings)
    trusted = _load_trusted_server_certificates(settings)
    server_der = await _discover_server_certificate(settings, endpoint, policy, mode)
    _verify_server_certificate(server_der, trusted, endpoint, settings.opcua_check_server_hostname)
    try:
        await client.set_security(policy, certificate, private_key, password, CertProperties(server_der, "der"), mode)
    except Exception as error:
        raise _safe_connection_error(error) from error

# Most importantly, this function connects to the OPC UA server, reads the value of a specified node, and returns it along with its timestamps. It handles configuration validation, security setup, and error management.
async def read_opcua_node(settings: Settings, node_id: str) -> OpcUaRead:
    try:
        client = await create_configured_opcua_client(settings)
       #Connect and read a node
        async with client:
            data_value = await client.get_node(node_id).read_data_value()
    except Exception as error:
        if isinstance(error, OpcUaConfigurationError):
            raise
        raise _safe_connection_error(error) from error
#Extract the returned value
    variant = data_value.Value
    if variant is None:
        raise OpcUaConnectionError("The OPC UA node returned no value.")
    return OpcUaRead(value=variant.Value,
        source_timestamp=data_value.SourceTimestamp,
        server_timestamp=data_value.ServerTimestamp,
    )

#Preparing the OPC UA client
async def create_configured_opcua_client(settings: Settings) -> Client:
    endpoint = _validate_connection_settings(settings)
    client = _ConfiguredOpcUaClient(url=endpoint,timeout=settings.opcua_timeout_seconds,)
    client.application_uri = settings.opcua_application_uri
    if settings.opcua_security_mode == "None":
        # Never a silent downgrade: an insecure channel is only used when it is configured
        # explicitly, and can be forbidden outright with OPCUA_REQUIRE_SECURE_TRANSPORT.
        if settings.opcua_require_secure_transport:
            raise OpcUaConfigurationError(
                "OPCUA_REQUIRE_SECURE_TRANSPORT is enabled but OPCUA_SECURITY_MODE is None; set Sign or SignAndEncrypt."
            )
        global _insecure_transport_warned
        if not _insecure_transport_warned:
            _insecure_transport_warned = True
            LOGGER.warning(
                "OPC UA is configured WITHOUT transport security (OPCUA_SECURITY_MODE=None): data is neither signed nor encrypted%s.",
                " and the server is not authenticated; username/password may be exposed" if settings.opcua_username.strip() else "",
            )
    else:
        await _configure_secure_channel(client, settings, endpoint)
    if settings.opcua_username.strip():
        client.set_user(settings.opcua_username.strip())
        client.set_password(settings.opcua_password.get_secret_value())

    return client

# test the connection to the OPC UA server by reading a well-known node (i=2258) that returns the server's current time. 
# This function is useful for verifying that the connection settings are correct and that the server is responsive.
async def test_opcua_connection(settings: Settings) -> dict[str, object]:
    result = await read_opcua_node(settings, "i=2258")
    server_time = result.value
    security = opcua_security_summary(settings)
    security["server_certificate_validated"] = (
        settings.opcua_security_mode != "None"
    )
    return {
        "connected": True,
        "endpoint": settings.opcua_endpoint.strip(),
        "test": "read_only",
        "server_time": server_time.isoformat() if isinstance(server_time, datetime) else str(server_time),
        "security": security,
        "message": (
            "Read-only OPC UA connection test succeeded without transport encryption."
            if settings.opcua_security_mode == "None"
            else f"Read-only OPC UA connection test succeeded over a secured channel ({settings.opcua_security_policy}, {settings.opcua_security_mode})."
        ),
    }

# Handled communication with the PLC.
# Plc-> OPC UA server -> client module-> FastAPI backend and collector