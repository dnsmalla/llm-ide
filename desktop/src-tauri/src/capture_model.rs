use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxNode { pub role: String, #[serde(default, skip_serializing_if="Option::is_none")] pub title: Option<String>, #[serde(default, skip_serializing_if="Option::is_none")] pub description: Option<String>, #[serde(default, skip_serializing_if="Option::is_none")] pub value: Option<String>, #[serde(default, skip_serializing_if="Vec::is_empty")] pub children: Vec<AxNode> }
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxAppTree { pub bundle_id: String, pub windows: Vec<AxNode> }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum AxReadError {
    PermissionDenied, CannotComplete, Unsupported,
    /// A read that was cut short and returned nothing. No reader reports this today (a cut-short read returns the
    /// part it read, see `capture_ax_macos::Budget::finish`); the session still handles it, and its tests build it.
    #[cfg_attr(not(test), allow(dead_code))]
    Truncated,
}
