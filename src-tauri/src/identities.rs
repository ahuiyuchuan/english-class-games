//! Exact identity reconstruction for game-owned package data. Games declare JSON
//! Pointer locations; native code never infers identities from teaching strings.
//! Author: ahui.
use crate::error::{AppError, AppResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// The verified lesson.json digest binds declarations to the package actually read.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageIdentityPlan {
    pub lesson_sha256: String,
    pub revisions: Vec<RevisionIdentityPlan>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionIdentityPlan {
    pub revision: u64,
    pub layout: IdentityLayout,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityLayout {
    pub identities: Vec<String>,
    pub references: Vec<String>,
    #[serde(default)]
    pub encoded_references: Vec<EncodedReferences>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncodedReferences {
    pub path: String,
    pub references: Vec<String>,
}

/// Require real game-data locations. A declaration cannot replace the lesson name,
/// raw draft input, origin metadata or another platform container field.
fn game_pointer(path: &str) -> AppResult<()> {
    if !path.starts_with("/gameData/") || path.len() > 2_000 {
        return Err(AppError::validation("游戏身份声明包含非法位置"));
    }
    Ok(())
}

fn string_at<'a>(value: &'a Value, path: &str) -> AppResult<&'a str> {
    value
        .pointer(path)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| AppError::validation("身份或引用位置不存在或不是非空文本").field(path))
}

/// History may reference an object removed from both current snapshots. Its
/// declared reference still receives a stable new identity in the imported copy.
fn register_reference(
    id: &str,
    mapping: &mut HashMap<String, String>,
    asset_mapping: &HashMap<String, String>,
) -> AppResult<()> {
    if id.len() > 200 || asset_mapping.contains_key(id) {
        return Err(AppError::validation("游戏内部引用与素材身份冲突或过长"));
    }
    mapping
        .entry(id.to_owned())
        .or_insert_with(|| Uuid::new_v4().to_string());
    Ok(())
}

/// Update only one declared string, never an arbitrary identical teaching value.
fn replace_at(value: &mut Value, path: &str, mapping: &HashMap<String, String>) -> AppResult<()> {
    let original = string_at(value, path)?;
    if let Some(replacement) = mapping.get(original) {
        let replacement = replacement.clone();
        *value
            .pointer_mut(path)
            .ok_or_else(|| AppError::validation("身份引用位置已变化").field(path))? =
            json!(replacement);
    }
    Ok(())
}

/// assetId is the explicit platform resource-reference contract. Values such as
/// english, meaning and audio.text are untouched even if equal to an old asset ID.
fn remap_assets(value: &mut Value, mapping: &HashMap<String, String>) {
    match value {
        Value::Object(object) => {
            if let Some(Value::String(id)) = object.get_mut("assetId") {
                if let Some(replacement) = mapping.get(id) {
                    *id = replacement.clone();
                }
            }
            for child in object.values_mut() {
                remap_assets(child, mapping);
            }
        }
        Value::Array(items) => {
            for item in items {
                remap_assets(item, mapping);
            }
        }
        _ => {}
    }
}

/// Draft inputs are a shared container contract. Remap the dot-delimited object
/// tokens and objectId only; the teacher's incomplete raw input remains verbatim.
fn remap_draft_inputs(document: &mut Value, mapping: &HashMap<String, String>) -> AppResult<()> {
    let Some(inputs) = document.get_mut("draftInputs") else {
        return Ok(());
    };
    let inputs = inputs
        .as_object_mut()
        .ok_or_else(|| AppError::validation("未完成输入必须为对象"))?;
    let mut remapped = serde_json::Map::new();
    for (key, mut input) in std::mem::take(inputs) {
        if let Some(Value::String(id)) = input.get_mut("objectId") {
            if let Some(replacement) = mapping.get(id) {
                *id = replacement.clone();
            }
        }
        let key = key
            .split('.')
            .map(|part| mapping.get(part).map_or(part, String::as_str))
            .collect::<Vec<_>>()
            .join(".");
        if remapped.insert(key, input).is_some() {
            return Err(AppError::validation("重建身份后草稿字段位置冲突"));
        }
    }
    *inputs = remapped;
    Ok(())
}

/// Validate every snapshot before mutating copies. The caller performs this before
/// resource writes or SQL inserts; failures leave the library entirely unchanged.
pub fn remap_revisions(
    documents: &mut [Value],
    source_id: &str,
    digest: &str,
    plan: &PackageIdentityPlan,
    asset_mapping: &HashMap<String, String>,
) -> AppResult<String> {
    if plan.lesson_sha256 != digest || plan.revisions.len() != documents.len() {
        return Err(AppError::validation(
            "课件包已变化或身份声明缺少修订，请重新预览",
        ));
    }
    let mut layouts = HashMap::new();
    for revision in &plan.revisions {
        if layouts
            .insert(revision.revision, &revision.layout)
            .is_some()
        {
            return Err(AppError::validation("身份声明包含重复修订"));
        }
    }
    let local_id = Uuid::new_v4().to_string();
    let mut mapping = HashMap::from([(source_id.to_owned(), local_id.clone())]);
    for document in documents.iter() {
        let layout = layouts
            .get(&document["revision"].as_u64().unwrap_or(0))
            .ok_or_else(|| AppError::validation("身份声明与实际修订不一致"))?;
        let location_count = layout.identities.len()
            + layout.references.len()
            + layout
                .encoded_references
                .iter()
                .map(|item| 1 + item.references.len())
                .sum::<usize>();
        if location_count > 10_000 {
            return Err(AppError::validation("游戏身份声明超过允许数量"));
        }
        let mut paths = HashSet::new();
        let mut owned = HashSet::new();
        for path in &layout.identities {
            game_pointer(path)?;
            let id = string_at(document, path)?;
            if !paths.insert(path)
                || !owned.insert(id)
                || id.len() > 200
                || id == source_id
                || asset_mapping.contains_key(id)
            {
                return Err(AppError::validation("游戏内部身份重复或与平台身份冲突"));
            }
            mapping
                .entry(id.to_owned())
                .or_insert_with(|| Uuid::new_v4().to_string());
        }
        for path in &layout.references {
            game_pointer(path)?;
            if !paths.insert(path) {
                return Err(AppError::validation("游戏身份声明位置重复"));
            }
            register_reference(string_at(document, path)?, &mut mapping, asset_mapping)?;
        }
        for encoded in &layout.encoded_references {
            game_pointer(&encoded.path)?;
            if !paths.insert(&encoded.path) || encoded.references.len() > 1_000 {
                return Err(AppError::validation("编码引用声明重复或超过上限"));
            }
            let parsed: Value = serde_json::from_str(string_at(document, &encoded.path)?)?;
            for path in &encoded.references {
                if path.len() > 2_000 {
                    return Err(AppError::validation("编码引用位置过长"));
                }
                register_reference(string_at(&parsed, path)?, &mut mapping, asset_mapping)?;
            }
        }
    }
    for document in documents.iter_mut() {
        let layout = layouts[&document["revision"].as_u64().unwrap_or(0)];
        for path in layout.identities.iter().chain(&layout.references) {
            replace_at(document, path, &mapping)?;
        }
        for encoded in &layout.encoded_references {
            let mut parsed: Value = serde_json::from_str(string_at(document, &encoded.path)?)?;
            for path in &encoded.references {
                replace_at(&mut parsed, path, &mapping)?;
            }
            remap_assets(&mut parsed, asset_mapping);
            *document.pointer_mut(&encoded.path).unwrap() = json!(serde_json::to_string(&parsed)?);
        }
        remap_draft_inputs(document, &mapping)?;
        // Resource identities are independently managed and cannot alias a game's
        // objects. Origin metadata remains unchanged because only gameData is visited.
        remap_assets(&mut document["gameData"], asset_mapping);
        document["id"] = json!(local_id);
    }
    Ok(local_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_vocabulary_game_keeps_text_and_remaps_both_snapshots_and_draft_locations() {
        let lesson_id = Uuid::new_v4().to_string();
        let card_id = Uuid::new_v4().to_string();
        let asset_id = Uuid::new_v4().to_string();
        let local_asset = Uuid::new_v4().to_string();
        let field = format!("{card_id}.answer");
        let mut documents = vec![
            json!({"id":lesson_id,"revision":1,"gameData":{
                "cards":[{"key":card_id,"english":card_id,"assetId":asset_id}],
                "focus":card_id,
                "origin":{"id":card_id},
                "dependency":serde_json::to_string(&json!({"ref":card_id,"text":card_id,"assetId":asset_id})).unwrap()
            },"sourceLesson":{"id":lesson_id,"revision":1}}),
            json!({"id":lesson_id,"revision":2,"gameData":{
                "cards":[{"key":card_id,"english":card_id,"assetId":asset_id}],"focus":card_id
            },"draftInputs":{field.clone():{"objectId":card_id,"raw":card_id,"message":"尚未完成"}}}),
        ];
        let plan = PackageIdentityPlan {
            lesson_sha256: "verified-digest".into(),
            revisions: vec![
                RevisionIdentityPlan {
                    revision: 1,
                    layout: IdentityLayout {
                        identities: vec!["/gameData/cards/0/key".into()],
                        references: vec!["/gameData/focus".into()],
                        encoded_references: vec![EncodedReferences {
                            path: "/gameData/dependency".into(),
                            references: vec!["/ref".into()],
                        }],
                    },
                },
                RevisionIdentityPlan {
                    revision: 2,
                    layout: IdentityLayout {
                        identities: vec!["/gameData/cards/0/key".into()],
                        references: vec!["/gameData/focus".into()],
                        ..Default::default()
                    },
                },
            ],
        };
        let local_id = remap_revisions(
            &mut documents,
            &lesson_id,
            "verified-digest",
            &plan,
            &HashMap::from([(asset_id.clone(), local_asset.clone())]),
        )
        .unwrap();
        let mapped = documents[0]["gameData"]["cards"][0]["key"]
            .as_str()
            .unwrap();
        assert_ne!(mapped, card_id);
        assert_ne!(local_id, lesson_id);
        for document in &documents {
            assert_eq!(document["id"], local_id);
            assert_eq!(document["gameData"]["focus"], mapped);
            assert_eq!(document["gameData"]["cards"][0]["key"], mapped);
            assert_eq!(document["gameData"]["cards"][0]["english"], card_id);
            assert_eq!(document["gameData"]["cards"][0]["assetId"], local_asset);
        }
        assert_eq!(documents[0]["sourceLesson"]["id"], lesson_id);
        assert_eq!(documents[0]["gameData"]["origin"]["id"], card_id);
        let input = &documents[1]["draftInputs"][format!("{mapped}.answer")];
        assert_eq!(input["objectId"], mapped);
        assert_eq!(input["raw"], card_id);
        assert!(documents[1]["draftInputs"].get(&field).is_none());
        let dependency: Value =
            serde_json::from_str(documents[0]["gameData"]["dependency"].as_str().unwrap()).unwrap();
        assert_eq!(dependency["ref"], mapped);
        assert_eq!(dependency["text"], card_id);
        assert_eq!(dependency["assetId"], local_asset);
    }

    #[test]
    fn wrong_digest_missing_revision_and_platform_field_declarations_are_rejected() {
        let lesson_id = Uuid::new_v4().to_string();
        let document =
            json!({"id":lesson_id,"name":"课堂标题","revision":1,"gameData":{"key":"owned"}});
        let plan = PackageIdentityPlan {
            lesson_sha256: "digest".into(),
            revisions: vec![RevisionIdentityPlan {
                revision: 1,
                layout: IdentityLayout {
                    identities: vec!["/gameData/key".into()],
                    ..Default::default()
                },
            }],
        };
        assert!(remap_revisions(
            &mut [document.clone()],
            &lesson_id,
            "changed",
            &plan,
            &HashMap::new()
        )
        .is_err());
        let mut missing = plan.clone();
        missing.revisions.clear();
        assert!(remap_revisions(
            &mut [document.clone()],
            &lesson_id,
            "digest",
            &missing,
            &HashMap::new()
        )
        .is_err());
        let mut wrong = plan.clone();
        wrong.revisions[0].layout.identities = vec!["/name".into()];
        let mut actual = [document.clone()];
        assert!(
            remap_revisions(&mut actual, &lesson_id, "digest", &wrong, &HashMap::new()).is_err()
        );
        assert_eq!(actual[0], document);
    }

    #[test]
    fn declared_history_only_reference_is_remapped_without_rewriting_its_text() {
        let source_id = Uuid::new_v4().to_string();
        let removed = Uuid::new_v4().to_string();
        let mut documents = [json!({"id":source_id,"revision":1,"gameData":{
            "history":{"objectId":removed,"meaning":removed},
            "dependency":serde_json::to_string(&json!({"oldId":removed})).unwrap()
        }})];
        let plan = PackageIdentityPlan {
            lesson_sha256: "digest".into(),
            revisions: vec![RevisionIdentityPlan {
                revision: 1,
                layout: IdentityLayout {
                    references: vec!["/gameData/history/objectId".into()],
                    encoded_references: vec![EncodedReferences {
                        path: "/gameData/dependency".into(),
                        references: vec!["/oldId".into()],
                    }],
                    ..Default::default()
                },
            }],
        };
        remap_revisions(&mut documents, &source_id, "digest", &plan, &HashMap::new()).unwrap();
        let mapped = documents[0]["gameData"]["history"]["objectId"]
            .as_str()
            .unwrap();
        assert_ne!(mapped, removed);
        assert_eq!(documents[0]["gameData"]["history"]["meaning"], removed);
        let dependency: Value =
            serde_json::from_str(documents[0]["gameData"]["dependency"].as_str().unwrap()).unwrap();
        assert_eq!(dependency["oldId"], mapped);
    }
}
