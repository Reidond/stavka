use crate::settings::get_saves_dir;
use anyhow::{Context, Result};
use chrono::{DateTime, Local};
use std::path::PathBuf;
use tokio::fs;

#[derive(Debug)]
struct SaveInfo {
    name: String,
    modified: DateTime<Local>,
    size: u64,
}

async fn list_saves() -> Result<Vec<SaveInfo>> {
    let saves_dir = get_saves_dir()?;
    
    if !saves_dir.exists() {
        return Ok(Vec::new());
    }
    
    let mut saves = Vec::new();
    let mut entries = fs::read_dir(&saves_dir).await
        .with_context(|| format!("Failed to read saves directory: {}", saves_dir.display()))?;
    
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            let metadata = entry.metadata().await?;
            let modified: DateTime<Local> = metadata.modified()?.into();
            
            if let Some(name) = path.file_stem().and_then(|n| n.to_str()) {
                saves.push(SaveInfo {
                    name: name.to_string(),
                    modified,
                    size: metadata.len(),
                });
            }
        }
    }
    
    // Sort by modified date descending
    saves.sort_by(|a, b| b.modified.cmp(&a.modified));
    
    Ok(saves)
}

pub async fn cmd_list() -> Result<()> {
    let saves_dir = get_saves_dir()?;
    
    if !saves_dir.exists() {
        println!("No saves directory yet: {}", saves_dir.display());
        return Ok(());
    }
    
    let saves = list_saves().await?;
    
    if saves.is_empty() {
        println!("No saves found.");
        return Ok(());
    }
    
    println!("Saves in: {}\n", saves_dir.display());
    
    for save in &saves {
        let kb = save.size as f64 / 1024.0;
        let date = save.modified.format("%Y-%m-%d %H:%M:%S");
        println!("  {:<40} {:>8.1} KB   {}", save.name, kb, date);
    }
    
    println!("\n{} save(s) total", saves.len());
    
    Ok(())
}

pub async fn cmd_import(source_path: &PathBuf, name: Option<&str>) -> Result<()> {
    if !source_path.exists() {
        anyhow::bail!("File not found: {}", source_path.display());
    }
    
    let saves_dir = get_saves_dir()?;
    fs::create_dir_all(&saves_dir).await
        .with_context(|| format!("Failed to create saves directory: {}", saves_dir.display()))?;
    
    // Determine destination name
    let dest_name = if let Some(n) = name {
        if n.ends_with(".json") {
            n.to_string()
        } else {
            format!("{}.json", n)
        }
    } else {
        source_path.file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .context("Failed to get filename from source path")?
    };
    
    let dest_path = saves_dir.join(&dest_name);
    
    fs::copy(&source_path, &dest_path).await
        .with_context(|| format!("Failed to copy file to {}", dest_path.display()))?;
    
    println!("Imported: {}", source_path.display());
    println!("     To: {}", dest_path.display());
    
    // Get the base name without .json for the --save flag
    let save_name = dest_name.trim_end_matches(".json");
    println!("\nStart server with: arma-test-server start --save {}", save_name);
    
    Ok(())
}

pub async fn cmd_info(name: &str) -> Result<()> {
    let saves_dir = get_saves_dir()?;
    
    // Ensure name has .json extension
    let file_name = if name.ends_with(".json") {
        name.to_string()
    } else {
        format!("{}.json", name)
    };
    
    let file_path = saves_dir.join(&file_name);
    
    if !file_path.exists() {
        anyhow::bail!("Save not found: {}", file_path.display());
    }
    
    let content = fs::read_to_string(&file_path).await
        .with_context(|| format!("Failed to read save file: {}", file_path.display()))?;
    
    let data: serde_json::Value = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse save file: {}", file_path.display()))?;
    
    let metadata = fs::metadata(&file_path).await?;
    let modified: DateTime<Local> = metadata.modified()?.into();
    
    println!("Save:     {}", file_name);
    println!("Size:     {:.1} KB", metadata.len() as f64 / 1024.0);
    println!("Modified: {}", modified.format("%Y-%m-%d %H:%M:%S"));
    
    if let Some(obj) = data.as_object() {
        let keys: Vec<_> = obj.keys().collect();
        let keys_str: Vec<_> = keys.iter().map(|k| k.as_str()).collect();
        println!("Keys:     {}", keys_str.join(", "));
    }
    
    // Preview first 800 chars
    let preview = content.chars().take(800).collect::<String>();
    println!("\nPreview:\n{}", preview);
    if content.len() > 800 {
        println!("... (truncated)");
    }
    
    Ok(())
}

#[derive(Debug, Clone)]
pub enum SavesCommand {
    List,
    Import { source: PathBuf, name: Option<String> },
    Info { name: String },
}

pub async fn run(cmd: SavesCommand) -> Result<()> {
    match cmd {
        SavesCommand::List => cmd_list().await,
        SavesCommand::Import { source, name } => cmd_import(&source, name.as_deref()).await,
        SavesCommand::Info { name } => cmd_info(&name).await,
    }
}
