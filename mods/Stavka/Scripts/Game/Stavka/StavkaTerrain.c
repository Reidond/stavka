// Classification v1 samples native height, ocean and local slope. Cover stays
// conservative until vegetation/building/navmesh classifiers are available.
class StavkaTerrain
{
  static string Hex(int value)
  {
    string digits = "0123456789abcdef";
    string encoded;
    for (int shift = 28; shift >= 0; shift -= 4) encoded += digits.Get((value >> shift) & 15);
    return encoded;
  }

  static string Hash(string canonical)
  {
    int primary = -2128831035;
    int secondary = -1640531527;
    for (int index = 0; index < canonical.Length(); index++)
    {
      int code = canonical.ToAscii(index);
      primary = (primary ^ code) * 16777619;
      secondary = (secondary ^ (code + index)) * 1540483477;
    }
    return "stavka-map-v1-" + Hex(primary) + Hex(secondary);
  }

  static string Upload(StavkaConfig config)
  {
    BaseWorld world = GetGame().GetWorld();
    vector minimum, maximum;
    world.GetBoundBox(minimum, maximum);
    // Protocol v1 grids have a fixed world origin (0,0); no offset field exists.
    int resolution = Math.Ceil(config.mapResolution);
    int width = Math.Ceil(maximum[0] / resolution);
    int height = Math.Ceil(maximum[2] / resolution);
    if (width <= 0 || height <= 0) return "";
    while (width * height > 4096)
    {
      resolution *= 2;
      width = Math.Ceil(maximum[0] / resolution);
      height = Math.Ceil(maximum[2] / resolution);
    }
    array<string> cells = {};
    array<string> canonicalCells = {};
    for (int z = 0; z < height; z++)
    {
      for (int x = 0; x < width; x++)
      {
        float px = (x + 0.5) * resolution;
        float pz = (z + 0.5) * resolution;
        if (px < minimum[0] || px > maximum[0] || pz < minimum[2] || pz > maximum[2]) continue;
        float elevation = world.GetSurfaceY(px, pz);
        if (!StavkaWire.IsFinite(elevation) || elevation == -256) continue;
        float east = world.GetSurfaceY(px + 5, pz);
        float north = world.GetSurfaceY(px, pz + 5);
        if (!StavkaWire.IsFinite(east) || !StavkaWire.IsFinite(north) || east == -256 || north == -256) continue;
        int roundedElevation = Math.Round(elevation);
        if (roundedElevation == -256) continue;
        float gradient = Math.Sqrt(Math.Pow((east - elevation) / 5, 2) + Math.Pow((north - elevation) / 5, 2));
        int slope = Math.ClampInt(Math.Round(Math.Atan2(gradient, 1) * Math.RAD2DEG), 0, 90);
        string terrain = "field";
        bool traversable = slope <= 35;
        if (elevation < world.GetOceanHeight(px, pz)) { terrain = "water"; traversable = false; }
        string grid = "[" + x.ToString() + "," + z.ToString() + "]";
        cells.Insert("{\"grid\":" + grid + ",\"type\":" + StavkaWire.Quote(terrain) + ",\"cover\":\"none\",\"elevation\":"
          + roundedElevation.ToString() + ",\"slope_degrees\":" + slope.ToString() + ",\"traversable\":" + StavkaWire.Boolean(traversable) + "}");
        canonicalCells.Insert("[" + x.ToString() + "," + z.ToString() + "," + StavkaWire.Quote(terrain) + ",\"none\","
          + roundedElevation.ToString() + "," + slope.ToString() + "," + StavkaWire.Boolean(traversable) + "]");
      }
    }
    if (cells.IsEmpty()) return "";
    string canonical = "[\"stavka-map-briefing-v1\"," + StavkaWire.Quote(config.mapName) + "," + width.ToString() + "," + height.ToString()
      + "," + resolution.ToString() + ",\"arma_extracted\",1," + StavkaSnapshot.Join(canonicalCells) + ",[]]";
    int size = Math.Max(width, height);
    string briefing = "{\"map_name\":" + StavkaWire.Quote(config.mapName) + ",\"grid_size\":" + size.ToString()
      + ",\"grid_width\":" + width.ToString() + ",\"grid_height\":" + height.ToString() + ",\"grid_resolution_meters\":" + resolution.ToString()
      + ",\"source\":\"arma_extracted\",\"classification_version\":1,\"content_hash\":" + StavkaWire.Quote(Hash(canonical))
      + ",\"terrain_grid\":" + StavkaSnapshot.Join(cells) + ",\"key_features\":[]}";
    return "{" + config.IdentityJson() + ",\"mission_id\":" + StavkaWire.Quote(config.missionId) + ",\"mission_epoch\":" + config.epoch.ToString()
      + ",\"briefing\":" + briefing + "}";
  }
}
