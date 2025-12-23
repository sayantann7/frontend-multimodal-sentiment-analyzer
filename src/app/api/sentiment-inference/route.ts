import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  InvokeEndpointCommand,
  SageMakerRuntimeClient,
} from "@aws-sdk/client-sagemaker-runtime";
import { NextResponse } from "next/server";
import { env } from "~/env";
import { checkAndUpdateQuota } from "~/lib/quota";
import { db } from "~/server/db";

export async function POST(req: Request) {
  try {
    // Get API key from the header
    const apiKey = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!apiKey) {
      return NextResponse.json({ error: "API key required" }, { status: 401 });
    }

    // Find the user by API key
    const quota = await db.apiQuota.findUnique({
      where: {
        secretKey: apiKey,
      },
      select: {
        userId: true,
      },
    });

    if (!quota) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }

    const { key } = (await req.json()) as { key: string | undefined };

    if (!key) {
      return NextResponse.json({ error: "Key is required" }, { status: 400 });
    }

    const file = await db.videoFile.findUnique({
      where: { key },
      select: { userId: true, analyzed: true },
    });

    if (!file) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    if (file.userId !== quota.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (file.analyzed) {
      return NextResponse.json(
        { error: "File already analyzed" },
        { status: 400 },
      );
    }

    const hasQuota = await checkAndUpdateQuota(quota.userId, true);

    if (!hasQuota) {
      return NextResponse.json(
        { error: "Monthly quota exceeded" },
        { status: 429 },
      );
    }

    // Verify the file exists in S3 and has content
    const s3Client = new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });

    try {
      const headCommand = new HeadObjectCommand({
        Bucket: env.AWS_INFERENCE_BUCKET,
        Key: key,
      });
      const headResult = await s3Client.send(headCommand);
      console.log(`S3 file verified: ${key}, Size: ${headResult.ContentLength} bytes, ContentType: ${headResult.ContentType}`);
      
      if (!headResult.ContentLength || headResult.ContentLength < 1000) {
        return NextResponse.json(
          { error: "Video file is too small or empty. Upload may have failed." },
          { status: 400 },
        );
      }
    } catch (s3Error: unknown) {
      console.error("S3 file verification failed:", s3Error);
      return NextResponse.json(
        { error: "Video file not found in storage. Please re-upload." },
        { status: 404 },
      );
    }

    // Call sagemaker endpoint
    const sagemakerClient = new SageMakerRuntimeClient({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const command = new InvokeEndpointCommand({
      EndpointName: env.AWS_ENDPOINT_NAME,
      ContentType: "application/json",
      Body: JSON.stringify({
        video_path: `s3://${env.AWS_INFERENCE_BUCKET}/${key}`,
      }),
    });

    const response = await sagemakerClient.send(command);
    const analysis: unknown = JSON.parse(new TextDecoder().decode(response.Body));

    await db.videoFile.update({
      where: { key },
      data: {
        analyzed: true,
      },
    });

    return NextResponse.json({
      analysis,
    });
  } catch (error: unknown) {
    console.error("Analysis error: ", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
