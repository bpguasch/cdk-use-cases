import {CustomResource, Duration, Stack, Tags} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloud9 from 'aws-cdk-lib/aws-cloud9';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';

const yaml = require('yaml')
const fs   = require('fs')

export interface CustomCloud9SsmProps {
    /**
     * Optional configuration for the SSM Document.
     *
     * @default: none
     */
    readonly ssmDocumentProps?: ssm.CfnDocumentProps

    /**
     * Optional configuration for the Cloud9 EC2 environment.
     *
     * @default: none
     */
    readonly cloud9Ec2Props?: cloud9.CfnEnvironmentEC2Props
}

export class CustomCloud9Ssm extends Construct {
    private static readonly DEFAULT_EBS_SIZE = 50
    private static readonly DEFAULT_DOCUMENT_FILE_NAME = `${__dirname}/assets/default_document.yml`
    private static readonly RESIZE_STEP_FILE_NAME = `${__dirname}/assets/resize_ebs_step.yml`
    private static readonly DEPLOY_CDK_STEP_FILE_NAME = `${__dirname}/assets/deploy_cdk_from_tar.yml`
    private static readonly ATTACH_PROFILE_FILE_NAME = `${__dirname}/assets/profile_attach.py`
    private static readonly DEFAULT_DOCUMENT_NAME = 'SsmDocument'

    private readonly document: ssm.CfnDocument

    /**
     * The IAM Role that is attached to the EC2 instance launched with the Cloud9 environment to grant it permissions to execute the statements in the SSM Document.
     */
    public readonly ec2Role: iam.Role

    /**
     * Adds one or more steps to the content of the SSM Document.
     * @param steps YAML formatted string containing one or more steps to be added to the mainSteps section of the SSM Document.
     */
    public addDocumentSteps(steps: string): void {
        // Add the mainSteps section if it doesn't exist
        if (!('mainSteps' in this.document.content)) {
            this.document.content['mainSteps'] = []
        }

        // Add the new step
        this.document.content['mainSteps'].push(...yaml.parse(steps))
    }

    /**
     * Adds one or more parameters to the content of the SSM Document.
     * @param parameters YAML formatted string containing one or more parameters to be added to the parameters section of the SSM Document.
     */
    public addDocumentParameters(parameters: string): void {
        // Add the parameters section if it doesn't exist
        if (!('parameters' in this.document.content)) {
            this.document.content['parameters'] = {}
        }

        // Add the new parameter
        this.document.content['parameters'] = Object.assign({}, this.document.content['parameters'], yaml.parse(parameters))
    }

    /**
     * Adds a step to the SSM Document content that resizes the EBS volume of the EC2 instance. Attaches the required policies to ec2Role.
     * @param size in GiB to resize the EBS volume to.
     */
    public resizeEBSTo(size: number): void {
        let steps: string = fs.readFileSync(CustomCloud9Ssm.RESIZE_STEP_FILE_NAME, 'utf8')
        steps = steps.replace('{{ size }}', String(size))

        // Add the resizing step
        this.addDocumentSteps(steps)

        // Grant permission to the EC2 instance to execute the statements included in the SSM Document
        this.ec2Role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ec2:DescribeInstances',
                'ec2:ModifyVolume',
                'ec2:DescribeVolumesModifications'
            ],
            resources: ['*']
        }))
    }

    /**
     * Adds a step to the SSM Document content that deploys a CDK project from its compressed version.
     * @param url from where to download the file using the wget command. Attaches the required policies to ec2Role.
     * @param stackName name of the stack to deploy
     */
    public deployCDKProject(url: string, stackName: string = ''): void {
        let steps: string = fs.readFileSync(CustomCloud9Ssm.DEPLOY_CDK_STEP_FILE_NAME, 'utf8')
        steps = steps.replace('{{ URL }}', url)
        steps = steps.replace('{{ STACK_NAME }}', stackName)


        // Add the deployment step
        this.addDocumentSteps(steps)

        // Grant permission to the EC2 instance to work with the s3 bucket that contains bootstrapped files
        this.ec2Role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:*'
            ],
            resources: ['arn:aws:s3:::cdk-*']
        }))

        // Grant permission to the EC2 instance to work with the stack that contains bootstrapped , and the stack being deployed
        const accountId = Stack.of(this).account
        const region = Stack.of(this).region

        this.ec2Role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'cloudformation:*',
            ],
            resources: [
                `arn:aws:cloudformation:${region}:${accountId}:stack/CDKToolkit/*`,
                `arn:aws:cloudformation:${region}:${accountId}:stack/${stackName}/*`
            ]
        }))
    }

    constructor(scope: Construct, id: string, props: CustomCloud9SsmProps = {}) {
        super(scope, id);

        let cloud9Env: cloud9.CfnEnvironmentEC2
        let ssmAssociation: ssm.CfnAssociation
        let customResource: CustomResource

        // Create the Cloud9 environment using the default configuration
        if (!props.cloud9Ec2Props) {
            cloud9Env = new cloud9.CfnEnvironmentEC2(this,'Cloud9Ec2Environment', {
                instanceType: "t3.large",
                imageId: "amazonlinux-2023-x86_64"
            })
        }
        // Create the Cloud9 environment using the received props
        else {
            cloud9Env = new cloud9.CfnEnvironmentEC2(this,'Cloud9Ec2Environment', props.cloud9Ec2Props)
        }

        // Add a unique tag to the environment to use it as a target for the SSM Association
        Tags.of(cloud9Env).add('stack-id', Stack.of(this).stackId)

        // Create a Role for the EC2 instance and an instance profile with it
        this.ec2Role = new iam.Role(this,'Ec2Role', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            roleName: 'CustomCloud9SsmEc2Role',
            managedPolicies: [
                iam.ManagedPolicy.fromManagedPolicyArn(
                    this,
                    'SsmManagedPolicy',
                    'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'
                )
            ]
        })
        const instanceProfile = new iam.CfnInstanceProfile(this,'Ec2InstanceProfile', {
            roles: [this.ec2Role.roleName]
        })

        // Create the SSM Document using the default configuration
        if (!props.ssmDocumentProps) {
            let content: string = fs.readFileSync(CustomCloud9Ssm.DEFAULT_DOCUMENT_FILE_NAME, 'utf8')

            const ssmDocumentProps = {
                documentType: 'Command',
                content: yaml.parse(content),
                name: CustomCloud9Ssm.DEFAULT_DOCUMENT_NAME
            }

            this.document = new ssm.CfnDocument(this,'SsmDocument', ssmDocumentProps)
            this.resizeEBSTo(CustomCloud9Ssm.DEFAULT_EBS_SIZE)
        }
        // Create the SSM Document using the received props
        else {
            if (!props.ssmDocumentProps.name) {
                throw new Error("The document name must be specified.")
            }

            this.document = new ssm.CfnDocument(this,'SsmDocument', props.ssmDocumentProps)
        }

        // Create an SSM Association to apply the document configuration
        ssmAssociation = new ssm.CfnAssociation(this,'SsmAssociation', {
            name: this.document.name as string,
            targets: [
                {
                    key: 'tag:stack-id',
                    values: [Stack.of(this).stackId]
                }
            ]
        })

        // Create the Lambda function that attaches the instance profile to the EC2 instance
        let code: string = fs.readFileSync(CustomCloud9Ssm.ATTACH_PROFILE_FILE_NAME, 'utf8')

        const lambdaFunction = new lambda.Function(this,'ProfileAttachLambdaFunction', {
            runtime: lambda.Runtime.PYTHON_3_11,
            code: lambda.Code.fromInline(code),
            handler: 'index.handler',
            timeout: Duration.seconds(800),
            retryAttempts: 0
        })

        // Give permissions to the function to execute some APIs
        lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ec2:DescribeInstances',
                'ec2:AssociateIamInstanceProfile',
                'ec2:ReplaceIamInstanceProfileAssociation',
                'ec2:RebootInstances',
                'iam:ListInstanceProfiles',
                'iam:PassRole',
                'ssm:DescribeAssociationExecutions',
                'ssm:DescribeAssociationExecutionTargets'
            ],
            resources: ['*']
        }))

        // Create the Custom Resource that invokes the Lambda function
        customResource = new CustomResource(this, 'CustomResource', {
            serviceToken: lambdaFunction.functionArn,
            properties: {
                stack_id: Stack.of(this).stackId,
                profile_arn: instanceProfile.attrArn,
                association_id: ssmAssociation.attrAssociationId
            }
        })

        instanceProfile.node.addDependency(this.ec2Role)

        ssmAssociation.node.addDependency(cloud9Env)
        ssmAssociation.node.addDependency(this.document)

        customResource.node.addDependency(instanceProfile)
        customResource.node.addDependency(ssmAssociation)
    }
}
