mod commands;
mod settings;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "arma-test-server",
    about = "Arma Reforger dedicated server management tool",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Setup and install the Arma Reforger server
    Setup,
    
    /// Start the Arma Reforger server
    Start {
        /// Load a specific save file
        #[arg(short, long, value_name = "NAME")]
        save: Option<String>,
        
        /// Start fresh without loading a save
        #[arg(short = 'F', long)]
        fresh: bool,
        
        /// Path to custom config file
        #[arg(short, long, value_name = "PATH")]
        config: Option<PathBuf>,
        
        /// Maximum FPS
        #[arg(short, long, default_value = "30")]
        fps: u32,
    },
    
    /// Manage save files
    Saves {
        #[command(subcommand)]
        command: SavesSubcommand,
    },
}

#[derive(Subcommand)]
enum SavesSubcommand {
    /// List all saves
    List,
    
    /// Import a save file
    Import {
        /// Path to the save file to import
        path: PathBuf,
        
        /// Optional name for the imported save
        name: Option<String>,
    },
    
    /// Show detailed info about a save
    Info {
        /// Name of the save file
        name: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    
    match cli.command {
        Commands::Setup => {
            commands::setup::run().await?;
        }
        
        Commands::Start { save, fresh, config, fps } => {
            let opts = commands::start::StartOptions {
                save,
                fresh,
                config,
                fps,
            };
            commands::start::run(opts).await?;
        }
        
        Commands::Saves { command } => {
            let cmd = match command {
                SavesSubcommand::List => commands::saves::SavesCommand::List,
                SavesSubcommand::Import { path, name } => {
                    commands::saves::SavesCommand::Import { source: path, name }
                }
                SavesSubcommand::Info { name } => {
                    commands::saves::SavesCommand::Info { name }
                }
            };
            commands::saves::run(cmd).await?;
        }
    }
    
    Ok(())
}
