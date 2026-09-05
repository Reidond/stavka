[WorkbenchPluginAttribute("Stavka resource lookup", "CLI resource inventory", "", "", {"ResourceManager"})]
class StavkaResourcesPlugin : WorkbenchPlugin
{
  ref array<string> matches = {};
  int total;

  string Quote(string value)
  {
    value.Replace("\\", "\\\\");
    value.Replace("\"", "\\\"");
    value.Replace("\n", "\\n");
    value.Replace("\r", "\\r");
    value.Replace("\t", "\\t");
    return "\"" + value + "\"";
  }

  void Found(ResourceName resource)
  {
    total++;
    if (matches.Count() < 100) matches.Insert(Quote(resource));
  }

  override void RunCommandline()
  {
    string query;
    string runId;
    string fingerprint;
    if (!System.GetCLIParam("stavkaResourceQuery", query) || query.IsEmpty()
      || !System.GetCLIParam("stavkaRunId", runId) || !System.GetCLIParam("stavkaSourceHash", fingerprint))
    {
      Workbench.Exit(2);
      return;
    }
    array<string> filters = {query};
    if (!Workbench.SearchResources(Found, null, filters))
    {
      Print("[StavkaTools] Resource search failed", LogLevel.ERROR);
      Workbench.Exit(3);
      return;
    }
    string body = "{\"schema_version\":1,\"run_id\":" + Quote(runId);
    body += ",\"source_hash\":" + Quote(fingerprint) + ",\"query\":" + Quote(query);
    body += ",\"total\":" + total.ToString() + ",\"resources\":[";
    for (int i = 0; i < matches.Count(); i++)
    {
      if (i > 0) body += ",";
      body += matches[i];
    }
    body += "]}";
    FileHandle file = FileIO.OpenFile("$profile:stavka-resources.json", FileMode.WRITE);
    if (!file) { Workbench.Exit(4); return; }
    file.Write(body);
    file.Close();
    Print("[StavkaTools] Resource lookup complete");
    Workbench.Exit(0);
  }
}
