modded class SCR_BaseGameMode
{
	protected float m_fTimer = 5.0;
	protected bool m_bBenchRan = false;

	override void EOnFrame(IEntity owner, float timeSlice)
	{
		super.EOnFrame(owner, timeSlice);

		if (m_bBenchRan)
			return;

		m_fTimer -= timeSlice;
		if (m_fTimer <= 0)
		{
			m_bBenchRan = true;
			Print("BENCHMARK TRIGGERED BY TIMER", LogLevel.NORMAL);
			RunTerrainBenchmark();
		}
	}

	protected void RunTerrainBenchmark()
	{
		Print("", LogLevel.NORMAL);
		Print("========================================", LogLevel.NORMAL);
		Print("  TERRAIN BENCHMARK STARTING", LogLevel.NORMAL);
		Print("========================================", LogLevel.NORMAL);

		BaseWorld world = GetGame().GetWorld();
		if (!world)
		{
			Print("[TerrainBench] ERROR: No world!", LogLevel.ERROR);
			return;
		}

		vector mins, maxs;
		world.GetBoundBox(mins, maxs);

		float mapSizeX = maxs[0] - mins[0];
		float mapSizeZ = maxs[2] - mins[2];
		float startX = mins[0];
		float startZ = mins[2];

		Print(string.Format("Map bounds: (%1, %2) to (%3, %4)",
			mins[0], mins[2], maxs[0], maxs[2]), LogLevel.NORMAL);
		Print(string.Format("Map size: %1m x %2m", mapSizeX, mapSizeZ), LogLevel.NORMAL);
		Print("----------------------------------------", LogLevel.NORMAL);

		BenchmarkGrid(world, "100m COARSE", 100, startX, startZ, mapSizeX, mapSizeZ);
		BenchmarkGrid(world, "50m  MEDIUM", 50, startX, startZ, mapSizeX, mapSizeZ);
		BenchmarkGrid(world, "25m  FINE", 25, startX, startZ, mapSizeX, mapSizeZ);
		BenchmarkGrid(world, "10m  ULTRA", 10, startX, startZ, mapSizeX, mapSizeZ);

		Print("========================================", LogLevel.NORMAL);
		Print("  TERRAIN BENCHMARK COMPLETE", LogLevel.NORMAL);
		Print("========================================", LogLevel.NORMAL);
	}

	protected void BenchmarkGrid(BaseWorld world, string label, float step,
		float startX, float startZ, float sizeX, float sizeZ)
	{
		int nx = Math.Ceil(sizeX / step);
		int nz = Math.Ceil(sizeZ / step);
		int total = nx * nz;

		array<float> heights = {};
		heights.Reserve(total);

		int t0 = System.GetTickCount();

		for (int x = 0; x < nx; x++)
		{
			float px = startX + (x * step);
			for (int z = 0; z < nz; z++)
			{
				float pz = startZ + (z * step);
				heights.Insert(world.GetSurfaceY(px, pz));
			}
		}

		int elapsed = System.GetTickCount() - t0;

		float hMin = 99999;
		float hMax = -99999;
		float hSum = 0;

		for (int i = 0; i < heights.Count(); i++)
		{
			float h = heights[i];
			if (h < hMin) hMin = h;
			if (h > hMax) hMax = h;
			hSum += h;
		}

		float hAvg = hSum / Math.Max(heights.Count(), 1);
		float rate = total / Math.Max(elapsed, 1);

		Print(string.Format("[%1]  %2 x %3 = %4 samples",
			label, nx, nz, total), LogLevel.NORMAL);
		Print(string.Format("  Time: %1 ms  |  %2 samples/ms",
			elapsed, rate), LogLevel.NORMAL);
		Print(string.Format("  Heights: min=%1  max=%2  avg=%3",
			hMin, hMax, hAvg), LogLevel.NORMAL);
		Print("----------------------------------------", LogLevel.NORMAL);
	}
}
