//! Native platform envelopes. Game content stays opaque JSON, not Rust game fields.
//! Author: ahui.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Immutable audio metadata; paths are internal and never needed by portable HTML.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAsset {
    pub asset_id: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub duration_ms: f64,
    /// Actual decoder metadata. Old libraries/packages may omit it; callers must
    /// decode and inspect the sound instead of estimating samples from file size.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sample_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub channels: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frame_count: Option<u64>,
    pub sha256: String,
    /// Stored provenance, independent of whether the teacher retains this sound
    /// in the resource library. Package import preserves this category.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub language: String,
}

/// One requested utterance, preserving case and the source object's identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechItem {
    pub request_id: String,
    pub object_id: String,
    pub text: String,
    pub language: String,
    pub voice_id: Option<String>,
    pub rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub task_id: String,
    pub kind: String,
    pub lesson_id: Option<String>,
    pub input_revision: Option<u64>,
    pub state: String,
    pub stage: String,
    pub completed: usize,
    pub total: usize,
    pub results: Vec<Value>,
    pub failures: Vec<Value>,
    pub cancel_requested: bool,
    pub created_at: String,
    pub updated_at: String,
    /// A retry is a new task; the terminal source record is never reopened.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub retry_of: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedFile {
    pub token: String,
    pub name: String,
    pub byte_length: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub local_copy: String,
    pub sha256: String,
    pub byte_length: u64,
    pub completed: bool,
    /// A verified local artifact exists even when target selection/copy failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<crate::error::AppError>,
}
