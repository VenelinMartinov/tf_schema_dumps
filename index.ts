import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as fs from "fs";

interface BucketPermissionToDataAccountArgs {
  bucketName: pulumi.Input<string>;
  rolesArn: pulumi.Input<string>[];
  addELBAccess?: boolean;
  enforceBucketOwnership?: boolean;
  snowpipeNotificationChannel?: pulumi.Input<string>;
}

const dw_workflows_loader = new pulumi.StackReference("dw-workflows-loader", {name: "pulumi/dwh-workflows-loader-prodbuckets/production"});
const bucketReaderRole = dw_workflows_loader.getOutput("dwhBucketReaderRole");

export class BucketPermissionToDataAccount extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: BucketPermissionToDataAccountArgs,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi:datawarehouse:bucket-permissions", name, {}, opts);

    let statements: aws.iam.PolicyStatement[] = [];

    for (const roleArn of args.rolesArn) {
      statements.push({
        Effect: "Allow",
        Principal: {
          AWS: roleArn,
        },
        Action: ["s3:GetObject", "s3:GetObjectVersion"],
        Resource: [pulumi.interpolate`arn:aws:s3:::${args.bucketName}/*`],
      });

      statements.push({
        Effect: "Allow",
        Principal: {
          AWS: roleArn,
        },
        Action: ["s3:ListBucket", "s3:GetBucketLocation"],
        Resource: [pulumi.interpolate`arn:aws:s3:::${args.bucketName}`],
      });
    }

    if (args.addELBAccess === true) {
      let serviceAccount = "arn:aws:iam::797873946194:root";

      statements.push({
        Effect: "Allow",
        Principal: { AWS: serviceAccount },
        Action: ["s3:PutObject"],
        Resource: [
          pulumi.interpolate`arn:aws:s3:::${args.bucketName}/alb/AWSLogs/*`,
        ],
      });
    }

    new aws.s3.BucketPolicy(
      `allow-data-access-to-${name}`,
      {
        bucket: args.bucketName,
        policy: {
          Version: "2012-10-17",
          Statement: statements,
        },
      },
      { parent: this }
    );

    if (args.snowpipeNotificationChannel) {
      const bucketNotification = new aws.s3.BucketNotification(
        `dwh-${name}-snowpipe-notification`,
        {
          bucket: args.bucketName,
          queues: [
            {
              queueArn: args.snowpipeNotificationChannel,
              events: ["s3:ObjectCreated:*"],
            },
          ],
        }
      );
    }

    if (args.enforceBucketOwnership === true) {
      const ownershipControls = new aws.s3.BucketOwnershipControls(
        `dwh-${name}-ownership-rules`,
        {
          bucket: args.bucketName,
          rule: {
            objectOwnership: "BucketOwnerEnforced",
          },
        }
      );
    }
  }
}

// Create an AWS resource (S3 Bucket)
const bucket = new aws.s3.Bucket("terraform-schema-bucket", {
  tags: {
    owner: "vvm",
  },
});

new BucketPermissionToDataAccount("terraform-schema-bucket", {
  bucketName: bucket.bucket,
  rolesArn: [bucketReaderRole],
  addELBAccess: false,
  enforceBucketOwnership: true,
});

// list all files under ./outputs
const files = fs.readdirSync("./outputs");

// get the current year, month and day
const today = new Date();
const year = today.getFullYear();
const month = today.getMonth() + 1;
const day = today.getDate();

// now for each file containing _resources_ in the name create a bucket object under Resources/year/month/day
for (const file of files) {
  if (file.includes("_resources_")) {
    new aws.s3.BucketObject(
      file,
      {
        bucket: bucket,
        key: `Resources/${year}/${month}/${day}/${file}`,
        source: new pulumi.asset.FileAsset(`./outputs/${file}`),
      },
      {
        retainOnDelete: true,
      }
    );
  }

  if (file.includes("_schemas_")) {
    new aws.s3.BucketObject(
      file,
      {
        bucket: bucket,
        key: `Schemas/${year}/${month}/${day}/${file}`,
        source: new pulumi.asset.FileAsset(`./outputs/${file}`),
      },
      {
        retainOnDelete: true,
      }
    );
  }
}
